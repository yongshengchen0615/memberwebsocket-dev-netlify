begin;
create table platform_private.module_notification_routes (
 tenant_id uuid not null references platform_private.tenants(id) on delete restrict,
 feature text not null check(feature in ('membership','points','events','calendar','booking')),
 purpose text not null check(purpose in ('admin','member')),
 mode text not null check(mode in ('inherit','custom','disabled')),
 channel_id text,
 envelope jsonb,
 verified_at timestamptz,
 updated_at timestamptz not null default now(),
 primary key(tenant_id,feature,purpose),
 check(purpose='member' or feature='booking'),
 check(mode<>'custom' or coalesce(channel_id~'^[0-9]{5,30}$' and verified_at is not null and envelope->>'version'='1'
  and char_length(envelope->>'iv')=16 and char_length(envelope->>'data')>40,false))
);
alter table platform_private.module_notification_routes enable row level security;
revoke all on platform_private.module_notification_routes from public,anon,authenticated;
grant select,insert,update on platform_private.module_notification_routes to service_role;

create function public.platform_save_notification_route(p_actor text,p_feature text,p_purpose text,p_mode text,
 p_expected_version integer,p_request_id uuid,p_payload_hash text,p_channel_id text default null,p_envelope jsonb default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants; r platform_private.requests; summary jsonb;
begin
 if p_feature is null or p_feature not in ('membership','points','events','calendar','booking')
  or p_purpose is null or p_purpose not in ('admin','member') or (p_purpose='admin' and p_feature<>'booking')
  or p_mode is null or p_mode not in ('inherit','custom','disabled') or p_request_id is null
  or p_expected_version is null or p_expected_version<1 or p_payload_hash is null or p_payload_hash!~'^[a-f0-9]{64}$'
  then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 select * into t from platform_private.tenants where owner_line_user_id=p_actor for update;
 if not found or t.status<>'active' then raise exception 'PLATFORM_TENANT_NOT_FOUND'; end if;
 if t.expires_at<=clock_timestamp() then raise exception 'TENANT_EXPIRED'; end if;
 if not coalesce((t.features->>p_feature)::boolean,false) then raise exception 'PLATFORM_FEATURE_DISABLED'; end if;
 if not exists(select 1 from platform_private.applications where tenant_id=t.id and applicant_line_user_id=p_actor and status='approved')
  then raise exception 'PLATFORM_APPLICATION_NOT_APPROVED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into r from platform_private.requests where request_id=p_request_id;
 if found then
  if r.actor<>p_actor or r.operation<>'notification:'||p_feature||':'||p_purpose or r.payload_hash<>p_payload_hash
   then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  return r.result;
 end if;
 if t.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
 insert into platform_private.module_notification_routes(tenant_id,feature,purpose,mode,channel_id,envelope,verified_at)
 values(t.id,p_feature,p_purpose,p_mode,case when p_mode='custom' then p_channel_id end,
  case when p_mode='custom' then p_envelope end,case when p_mode='custom' then clock_timestamp() end)
 on conflict(tenant_id,feature,purpose) do update set mode=excluded.mode,channel_id=excluded.channel_id,envelope=excluded.envelope,
  verified_at=excluded.verified_at,updated_at=clock_timestamp();
 summary:=jsonb_build_object('mode',p_mode,'channelId',case when p_mode='custom' then p_channel_id end,
  'verifiedAt',case when p_mode='custom' then clock_timestamp() end);
 -- Notification-only setup must preserve an existing shared Login/LIFF and
 -- inherited credential envelope for a newly granted module.
 if not (t.module_line ? p_feature) and t.credentials_configured then
  insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)
   select t.id,p_feature,s.envelope,'tenant' from platform_private.tenant_secrets s where s.tenant_id=t.id
   on conflict(tenant_id,feature)do nothing;
  if not exists(select 1 from platform_private.module_secrets where tenant_id=t.id and feature=p_feature)
   then raise exception 'PLATFORM_CREDENTIALS_REQUIRED';end if;
 end if;
 update platform_private.tenants set module_line=jsonb_set(module_line,array[p_feature],
  coalesce(module_line->p_feature,jsonb_build_object('line',line_config,'credentialsConfigured',credentials_configured))||jsonb_build_object('notifications',
   coalesce(module_line->p_feature->'notifications','{}'::jsonb)||jsonb_build_object(p_purpose,summary))),
  version=version+1,updated_by=p_actor,updated_at=clock_timestamp() where id=t.id returning * into t;
 insert into platform_private.audit_events(actor,tenant_id,action,detail)
  values(p_actor,t.id,'NOTIFICATION_ROUTE_UPDATED',jsonb_build_object('feature',p_feature,'purpose',p_purpose,'mode',p_mode,'version',t.version,'result','success'));
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
  values(p_request_id,p_actor,'notification:'||p_feature||':'||p_purpose,p_payload_hash,to_jsonb(t));
 return to_jsonb(t);
end $$;

create function public.platform_notification_credentials(p_tenant_id uuid,p_feature text) returns jsonb
language sql security invoker set search_path='' as $$
 select coalesce(jsonb_object_agg(n.purpose,jsonb_build_object('mode',n.mode,'envelope',n.envelope)),'{}'::jsonb)
 from platform_private.module_notification_routes n join platform_private.tenants t on t.id=n.tenant_id
 where n.tenant_id=p_tenant_id and n.feature=p_feature and t.status='active'
 and (t.expires_at is null or t.expires_at>clock_timestamp()) and t.features->>p_feature='true';
$$;
revoke all on function public.platform_save_notification_route(text,text,text,text,integer,uuid,text,text,jsonb),
 public.platform_notification_credentials(uuid,text) from public,anon,authenticated;
grant execute on function public.platform_save_notification_route(text,text,text,text,integer,uuid,text,text,jsonb),
 public.platform_notification_credentials(uuid,text) to service_role;
-- Later LIFF edits must preserve independently managed notification routes.
do $$ declare def text; begin
 select pg_get_functiondef('public.platform_save_module_line(text,text,integer,uuid,text,jsonb,jsonb)'::regprocedure) into def;
 def:=replace(def,'jsonb_set(module_line,array[p_feature],jsonb_build_object(',
  'jsonb_set(module_line,array[p_feature],coalesce(module_line->p_feature,''{}''::jsonb)||jsonb_build_object(');
 execute def;
end $$;
create function public.platform_notification_test(p_actor text,p_feature text,p_purpose text,p_expected_version integer,
 p_request_id uuid,p_payload_hash text,p_result jsonb default null) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;r platform_private.requests;
begin
 select * into t from platform_private.tenants where owner_line_user_id=p_actor for update;
 if not found or t.status<>'active' then raise exception 'PLATFORM_TENANT_NOT_FOUND';end if;
 if t.expires_at<=clock_timestamp() then raise exception 'TENANT_EXPIRED';end if;
 if p_feature is null or not coalesce((t.features->>p_feature)::boolean,false) then raise exception 'PLATFORM_FEATURE_DISABLED';end if;
 if p_purpose is null or p_purpose not in ('admin','member') or (p_purpose='admin' and p_feature<>'booking')
  or p_request_id is null or p_payload_hash is null or p_payload_hash!~'^[a-f0-9]{64}$' then raise exception 'PLATFORM_INVALID_INPUT';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into r from platform_private.requests where request_id=p_request_id for update;
 if found then
  if r.actor<>p_actor or r.operation<>'notification_test:'||p_feature||':'||p_purpose or r.payload_hash<>p_payload_hash
   then raise exception 'PLATFORM_REQUEST_CONFLICT';end if;
  if p_result is not null and r.result->>'state'<>'accepted' then
   if p_result->>'state' not in ('accepted','failed') then raise exception 'PLATFORM_INVALID_INPUT';end if;
   update platform_private.requests set result=p_result where request_id=p_request_id returning * into r;
   insert into platform_private.audit_events(actor,tenant_id,action,detail) values(p_actor,t.id,'NOTIFICATION_TEST',
    jsonb_build_object('feature',p_feature,'purpose',p_purpose,'result',p_result->>'state','status',p_result->'status'));
  end if;
  return r.result;
 end if;
 if p_expected_version is null or p_expected_version<>t.version then raise exception 'PLATFORM_CONFLICT';end if;
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
  values(p_request_id,p_actor,'notification_test:'||p_feature||':'||p_purpose,p_payload_hash,'{"state":"prepared"}'::jsonb);
 return '{"state":"prepared"}'::jsonb;
end $$;
revoke all on function public.platform_notification_test(text,text,text,integer,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.platform_notification_test(text,text,text,integer,uuid,text,jsonb) to service_role;
-- The existing cron also dispatches modules whose outgoing route is configured
-- independently of Login/LIFF. Disabled routes still drain as skipped/cancelled.
do $$ declare def text; begin
 select pg_get_functiondef('public.platform_tick_businesses()'::regprocedure) into def;
 def:=replace(def,
  'coalesce((t.module_line->''booking''->>''credentialsConfigured'')::boolean,false)',
  '(coalesce((t.module_line->''booking''->>''credentialsConfigured'')::boolean,false) or exists(select 1 from jsonb_each(coalesce(t.module_line->''booking''->''notifications'',''{}''::jsonb)) n where n.value->>''mode'' in (''custom'',''disabled'')))');
 def:=replace(def,
  'm.value->>''credentialsConfigured''=''true''',
  '(m.value->>''credentialsConfigured''=''true'' or m.value->''notifications''->''member''->>''mode'' in (''custom'',''disabled''))');
 execute def;
end $$;
notify pgrst,'reload schema';
commit;
