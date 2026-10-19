begin;
alter table platform_private.tenants add column module_line jsonb not null default '{}'::jsonb check(jsonb_typeof(module_line)='object');
create table platform_private.module_secrets (
 tenant_id uuid not null references platform_private.tenants(id) on delete restrict,
 feature text not null check(feature in ('membership','points','events','calendar','booking')),
 envelope jsonb not null check(coalesce(jsonb_typeof(envelope)='object' and envelope->>'version'='1' and char_length(envelope->>'iv')=16 and char_length(envelope->>'data')>40,false)),
 credential_scope text not null check(credential_scope in ('tenant','module')),
 updated_at timestamptz not null default now(),primary key(tenant_id,feature)
);
alter table platform_private.module_secrets enable row level security;
revoke all on platform_private.module_secrets from public,anon,authenticated;
grant select,insert,update on platform_private.module_secrets to service_role;
-- Snapshot legacy configuration without exposing or decrypting secrets. Legacy
-- credentials keep their original AES-GCM associated data until explicitly rotated.
insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)
 select t.id,f.key,s.envelope,'tenant' from platform_private.tenants t
 join platform_private.tenant_secrets s on s.tenant_id=t.id
 cross join lateral jsonb_each(t.features) f
 where f.value='true'::jsonb and f.key in ('membership','points','events','calendar','booking');
update platform_private.tenants t set module_line=(select coalesce(jsonb_object_agg(f.key,jsonb_build_object('line',t.line_config,'credentialsConfigured',t.credentials_configured)),'{}'::jsonb)
 from jsonb_each(t.features) f where f.value='true'::jsonb and f.key in ('membership','points','events','calendar','booking'));

create function public.platform_save_module_line(p_actor text,p_feature text,p_expected_version integer,p_request_id uuid,p_payload_hash text,p_line jsonb,p_secrets jsonb default null)
 returns jsonb language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants; r platform_private.requests; old_secret platform_private.tenant_secrets; configured boolean;
begin
 if p_feature is null or p_feature not in ('membership','points','events','calendar','booking') or p_request_id is null or p_expected_version is null or p_expected_version<1
  or p_payload_hash is null or p_payload_hash!~'^[a-f0-9]{64}$' or p_line is null or jsonb_typeof(p_line)<>'object' then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 -- Lock the owner row before checking grants; revocation and settings cannot race.
 select * into t from platform_private.tenants where owner_line_user_id=p_actor for update;
 if not found or t.status='suspended' then raise exception 'PLATFORM_TENANT_NOT_FOUND'; end if;
 if t.expires_at<=clock_timestamp() then raise exception 'TENANT_EXPIRED'; end if;
 if not coalesce((t.features->>p_feature)::boolean,false) then raise exception 'PLATFORM_FEATURE_DISABLED'; end if;
 if not exists(select 1 from platform_private.applications where tenant_id=t.id and applicant_line_user_id=p_actor and status='approved') then raise exception 'PLATFORM_APPLICATION_NOT_APPROVED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into r from platform_private.requests where request_id=p_request_id;
 if found then
  if r.actor<>p_actor or r.operation<>'module_line:'||p_feature or r.payload_hash<>p_payload_hash then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  return r.result;
 end if;
 if t.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
 if p_secrets is not null then
  insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)values(t.id,p_feature,p_secrets,'module')
  on conflict(tenant_id,feature)do update set envelope=excluded.envelope,credential_scope='module',updated_at=clock_timestamp();
 elsif not exists(select 1 from platform_private.module_secrets where tenant_id=t.id and feature=p_feature) then
  select * into old_secret from platform_private.tenant_secrets where tenant_id=t.id;
  if found then insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)values(t.id,p_feature,old_secret.envelope,'tenant');
  else raise exception 'PLATFORM_CREDENTIALS_REQUIRED'; end if;
 end if;
 update platform_private.tenants set module_line=jsonb_set(module_line,array[p_feature],jsonb_build_object('line',p_line,'credentialsConfigured',true)),
  -- Only the first module seeds the stable admin login and legacy fallback.
  line_config=case when line_config='{}'::jsonb then jsonb_build_object('memberLiffId','','pointsLiffId','','eventLiffId','','calendarLiffId','','bookingLiffId','')||p_line else line_config end,
  version=version+1,updated_by=p_actor,updated_at=clock_timestamp() where id=t.id returning * into t;
 insert into platform_private.audit_events(actor,tenant_id,action,detail)values(p_actor,t.id,'MODULE_LINE_UPDATED',jsonb_build_object('feature',p_feature,'version',t.version,'credentialsReplaced',p_secrets is not null,'result','success'));
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)values(p_request_id,p_actor,'module_line:'||p_feature,p_payload_hash,to_jsonb(t));
 return to_jsonb(t);
end $$;
create function public.platform_module_credentials(p_tenant_id uuid,p_feature text) returns jsonb
 language sql security invoker set search_path='' as $$
 select jsonb_build_object('envelope',s.envelope,'scope',s.credential_scope) from platform_private.module_secrets s where s.tenant_id=p_tenant_id and s.feature=p_feature;
$$;
revoke all on function public.platform_save_module_line(text,text,integer,uuid,text,jsonb,jsonb),public.platform_module_credentials(uuid,text) from public,anon,authenticated;
grant execute on function public.platform_save_module_line(text,text,integer,uuid,text,jsonb,jsonb),public.platform_module_credentials(uuid,text) to service_role;
-- Keep the existing dispatch schedule, including its expiry gate, while enabling
-- delivery for newly configured modules that have no legacy shared credential.
do $$ declare def text; begin
 select pg_get_functiondef('public.platform_tick_businesses()'::regprocedure) into def;
 def:=replace(def,'id,slug,runtime_schema,features,credentials_configured from','id,slug,runtime_schema,features,credentials_configured,module_line from');
 def:=replace(def,'if due and t.credentials_configured and project_url','if due and (t.credentials_configured or coalesce((t.module_line->''booking''->>''credentialsConfigured'')::boolean,false)) and project_url');
 def:=replace(def,') and t.credentials_configured then',') and (t.credentials_configured or exists(select 1 from jsonb_each(t.module_line) m where m.key in (''membership'',''points'',''events'') and m.value->>''credentialsConfigured''=''true'')) then');
 execute def;
end $$;
notify pgrst,'reload schema';
commit;
