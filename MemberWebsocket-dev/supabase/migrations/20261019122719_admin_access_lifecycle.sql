begin;
alter table platform_private.tenants
 add column expires_at timestamptz check (expires_at is null or isfinite(expires_at)),
 add column access_revoked_before timestamptz;
-- Existing suspended accounts must also require fresh LINE authentication on reinstatement.
update platform_private.tenants set access_revoked_before=clock_timestamp() where status='suspended';

create function platform_private.revoke_tenant_access() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if (new.status='suspended' and old.status<>'suspended')
   or (new.expires_at is distinct from old.expires_at and
     (new.expires_at<=clock_timestamp() or old.expires_at<=clock_timestamp())) then
  new.access_revoked_before:=greatest(old.access_revoked_before,clock_timestamp());
 end if;
 return new;
end $$;
revoke all on function platform_private.revoke_tenant_access() from public,anon,authenticated;
create trigger tenant_access_revocation before update on platform_private.tenants
 for each row execute function platform_private.revoke_tenant_access();

create function public.platform_update_tenant_access(
 p_actor text,p_tenant_id uuid,p_expected_version integer,p_request_id uuid,p_change jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants; previous platform_private.tenants; r platform_private.requests;
 h text; next_status text; next_expiry timestamptz; action text;
begin
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 if p_tenant_id is null or p_request_id is null or p_expected_version is null or p_expected_version<1
  or p_change is null or jsonb_typeof(p_change)<>'object'
  or (select count(*) from jsonb_object_keys(p_change))<>1
  or not (p_change ? 'status' or p_change ? 'expiresAt') then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 if p_change ? 'status' and not coalesce(p_change->>'status' in ('active','suspended'),false) then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 if p_change ? 'expiresAt' and p_change->'expiresAt'<>'null'::jsonb then
  if jsonb_typeof(p_change->'expiresAt')<>'string' or p_change->>'expiresAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$' then raise exception 'PLATFORM_INVALID_INPUT'; end if;
  begin next_expiry:=(p_change->>'expiresAt')::timestamptz;
  exception when others then raise exception 'PLATFORM_INVALID_INPUT'; end;
  if not isfinite(next_expiry) then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 end if;
 h:=p_tenant_id::text||':'||p_expected_version::text||':'||p_change::text;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into r from platform_private.requests where request_id=p_request_id;
 if found then
  if r.actor<>p_actor or r.operation<>'access' or r.payload_hash<>h then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  return r.result;
 end if;
 select * into previous from platform_private.tenants where id=p_tenant_id for update;
 if not found then raise exception 'PLATFORM_TENANT_NOT_FOUND'; end if;
 if previous.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
 next_status:=case when p_change ? 'status' then p_change->>'status' else previous.status end;
 if not (p_change ? 'expiresAt') then next_expiry:=previous.expires_at; end if;
 if next_status='active' and (previous.runtime_schema is null or previous.isolation_verified_at is null
  or previous.isolation_version is distinct from 'business-v1-20261019') then raise exception 'PLATFORM_RESUME_NOT_READY'; end if;
 t:=previous;
 if previous.status is distinct from next_status or previous.expires_at is distinct from next_expiry then
  update platform_private.tenants set status=next_status,expires_at=next_expiry,
   version=version+1,updated_by=p_actor,updated_at=clock_timestamp()
  where id=p_tenant_id returning * into t;
  action:=case when p_change ? 'expiresAt' then 'TENANT_EXPIRY_UPDATED' when next_status='active' then 'TENANT_RESUMED' else 'TENANT_SUSPENDED' end;
  insert into platform_private.audit_events(actor,tenant_id,action,detail)
  values(p_actor,p_tenant_id,action,jsonb_build_object('before',jsonb_build_object('status',previous.status,'expiresAt',previous.expires_at,'version',previous.version),
   'after',jsonb_build_object('status',t.status,'expiresAt',t.expires_at,'version',t.version),'result','success'));
 end if;
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
 values(p_request_id,p_actor,'access',h,to_jsonb(t));
 return to_jsonb(t);
end $$;
revoke all on function public.platform_update_tenant_access(text,uuid,integer,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.platform_update_tenant_access(text,uuid,integer,uuid,jsonb) to service_role;
create or replace function public.platform_suspend_tenant(p_actor text,p_tenant_id uuid,p_expected_version integer,p_request_id uuid)
returns jsonb language sql security invoker set search_path='' as $$
 select public.platform_update_tenant_access(p_actor,p_tenant_id,p_expected_version,p_request_id,'{"status":"suspended"}'::jsonb)
$$;
create or replace function public.platform_active_businesses() returns setof jsonb
language sql security invoker set search_path='' as $$
 select to_jsonb(t) from platform_private.tenants t where status='active' and runtime_schema is not null
 and (expires_at is null or expires_at>clock_timestamp());
$$;
-- Preserve the existing job and LINE save bodies; add the expiry gate at their existing state checks.
do $$ declare def text; begin
 select pg_get_functiondef('public.platform_tick_businesses()'::regprocedure) into def;
 if position('where status=''active'' and runtime_schema is not null' in def)=0 then raise exception 'UNEXPECTED_TICK_CONTRACT'; end if;
 execute replace(def,'where status=''active'' and runtime_schema is not null','where status=''active'' and runtime_schema is not null and (expires_at is null or expires_at>clock_timestamp())');
 select pg_get_functiondef('public.platform_save_my_line(text,integer,uuid,text,jsonb,jsonb)'::regprocedure) into def;
 if position('if v_tenant.version<>p_expected_version' in def)=0 then raise exception 'UNEXPECTED_LINE_CONTRACT'; end if;
 execute replace(def,'if v_tenant.version<>p_expected_version','if v_tenant.expires_at<=clock_timestamp() then raise exception ''TENANT_EXPIRED''; end if; if v_tenant.version<>p_expected_version');
end $$;
-- Grant changes retain their prior and resulting values in the same transaction.
do $$ declare def text; begin
 select pg_get_functiondef('public.platform_update_tenant_features(text,uuid,integer,jsonb,uuid,text)'::regprocedure) into def;
 def:=replace(def,'v_tenant platform_private.tenants;','v_tenant platform_private.tenants; v_before jsonb;');
 def:=replace(def,'update platform_private.tenants','v_before:=v_tenant.features; update platform_private.tenants');
 def:=replace(def,'''features'',p_features)', '''features'',p_features,''before'',v_before,''after'',p_features,''result'',''success'')');
 execute def;
end $$;
notify pgrst,'reload schema';
commit;
