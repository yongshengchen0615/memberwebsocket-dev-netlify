-- Fix hosted safeupdate rejection of unconditional frontdesk recipient DELETE (SQLSTATE 21000).
-- All edits remain in the existing authenticated tenant-scoped transaction.
create or replace function public.platform_frontdesk_admin(p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_action text,p_body jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;s platform_private.frontdesk_staff;r platform_private.requests;v jsonb;hash text;rid uuid;cfg jsonb;
begin
 t:=platform_private.require_merchant_access(p_actor,p_tenant_id,p_issued_at);
 if t.features->>'booking' is distinct from 'true' then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 if p_action not in ('get','settings.save','staff.save') or p_action is null then raise exception 'PLATFORM_INVALID_INPUT';end if;
 if p_action<>'get' then
  rid:=(p_body->>'requestId')::uuid;hash:=p_body->>'payloadHash';
  if rid is null or hash is null or hash!~'^[a-f0-9]{64}$' then raise exception 'PLATFORM_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended(rid::text,0));
  select * into r from platform_private.requests where request_id=rid;
  if found then
   if r.actor<>p_actor or r.operation<>'frontdesk:'||t.id||':'||p_action or r.payload_hash<>hash then raise exception 'FRONTDESK_REQUEST_CONFLICT';end if;
   return r.result;
  end if;
 end if;
 if p_action='settings.save' then
  if (p_body->>'expectedVersion')::integer is distinct from t.version then raise exception 'PLATFORM_CONFLICT';end if;
  cfg:=t.module_line->'booking'->'frontdesk';
  if cfg->>'loginChannelId' is not null and (cfg->>'loginChannelId' is distinct from p_body->>'loginChannelId' or cfg->>'liffId' is distinct from p_body->>'liffId') then raise exception 'PLATFORM_IMMUTABLE_IDENTITY';end if;
  if coalesce(p_body->>'loginChannelId','')!~'^[0-9]{5,30}$' or coalesce(p_body->>'liffId','')!~'^[0-9]{5,30}-[A-Za-z0-9_-]+$'
   or split_part(p_body->>'liffId','-',1)<>p_body->>'loginChannelId' or jsonb_typeof(p_body->'enabled') is distinct from 'boolean'
   then raise exception 'PLATFORM_INVALID_INPUT';end if;
  if cfg->>'messagingChannelId' is not null and cfg->>'messagingChannelId' is distinct from p_body->>'messagingChannelId'
   and exists(select 1 from platform_private.frontdesk_staff where tenant_id=t.id) then raise exception 'PLATFORM_IMMUTABLE_IDENTITY';end if;
  -- Every Messaging Channel has exactly one merchant owner, including custom routes.
  if exists(select 1 from platform_private.line_channel_owners where channel_id=p_body->>'messagingChannelId' and tenant_id<>t.id) then raise exception 'FRONTDESK_CHANNEL_CONFLICT';end if;
  cfg:=jsonb_build_object('loginChannelId',p_body->>'loginChannelId','liffId',p_body->>'liffId','messagingChannelId',p_body->>'messagingChannelId','oaId',coalesce(p_body->>'oaId',cfg->>'oaId'),'revision',t.version+1,'enabled',(p_body->>'enabled')::boolean);
  if not(t.module_line ? 'booking') and t.credentials_configured then
   insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)
    select t.id,'booking',x.envelope,'tenant' from platform_private.tenant_secrets x where x.tenant_id=t.id
    on conflict(tenant_id,feature) do nothing;
  end if;
  insert into platform_private.module_notification_routes(tenant_id,feature,purpose,mode,channel_id,envelope,verified_at)
   values(t.id,'booking','frontdesk',case when (p_body->>'enabled')::boolean then 'custom' else 'disabled' end,p_body->>'messagingChannelId',p_body->'envelope',clock_timestamp())
   on conflict(tenant_id,feature,purpose) do update set mode=excluded.mode,channel_id=excluded.channel_id,envelope=coalesce(nullif(excluded.envelope,'null'),module_notification_routes.envelope),verified_at=excluded.verified_at,updated_at=clock_timestamp();
  update platform_private.tenants set module_line=jsonb_set(module_line,'{booking}',coalesce(module_line->'booking',jsonb_build_object('line',line_config,'credentialsConfigured',credentials_configured))||jsonb_build_object('frontdesk',cfg,'notifications',coalesce(module_line->'booking'->'notifications','{}')||jsonb_build_object('frontdesk',jsonb_build_object('mode',case when (p_body->>'enabled')::boolean then 'custom' else 'disabled' end,'channelId',p_body->>'messagingChannelId','verifiedAt',clock_timestamp())))),version=version+1,updated_at=clock_timestamp(),updated_by=p_actor where id=t.id returning * into t;
 elsif p_action='staff.save' then
  select * into s from platform_private.frontdesk_staff where id=(p_body->>'staffId')::uuid and tenant_id=t.id for update;
  if not found then raise exception 'FRONTDESK_NOT_FOUND';end if;
  if s.version is distinct from (p_body->>'expectedVersion')::integer then raise exception 'PLATFORM_CONFLICT';end if;
  if coalesce(p_body->>'status','') not in ('approved','rejected','suspended') or coalesce(p_body->>'permissionMode','') not in ('notify_only','review') then raise exception 'PLATFORM_INVALID_INPUT';end if;
  if p_body->>'status'='approved' and s.oa_verified_at is null then raise exception 'FRONTDESK_OA_REQUIRED';end if;
  update platform_private.frontdesk_staff set status=p_body->>'status',permission_mode=p_body->>'permissionMode',version=version+1,
   access_revoked_before=case when p_body->>'status'<>'approved' then clock_timestamp() else access_revoked_before end,
   reviewed_by=p_actor,reviewed_at=clock_timestamp(),updated_at=clock_timestamp() where id=s.id;
 end if;
 if p_action='settings.save' and t.module_line->'booking'->'frontdesk'->>'enabled'='false' then
  execute format('update %I.notice_outbox set status=''skipped'',last_error=''FRONTDESK_CONFIGURATION_DISABLED'' where channel=''frontdesk'' and status in (''pending'',''sending'')',t.runtime_schema);
 elsif p_action='staff.save' and p_body->>'status'<>'approved' then
  execute format('update %I.notice_outbox set status=''skipped'',last_error=''FRONTDESK_ACCESS_REVOKED'' where channel=''frontdesk'' and recipient=$1 and status in (''pending'',''sending'')',t.runtime_schema) using s.line_user_id;
 end if;
 if p_action<>'get' then
  -- Supabase PostgREST safeupdate requires a WHERE condition on DELETE.
  -- Reconcile only actual access revocations, retaining approved recipients.
  if t.module_line->'booking'->'frontdesk'->>'enabled'='true' then
   execute format('delete from %I.frontdesk_notice_recipients r where not exists (select 1 from platform_private.frontdesk_staff s where s.tenant_id=$1 and s.login_channel_id=$2 and s.status=''approved'' and s.oa_verified_at is not null and s.line_user_id=r.line_user_id)',t.runtime_schema) using t.id,t.module_line->'booking'->'frontdesk'->>'loginChannelId';
   execute format('insert into %I.frontdesk_notice_recipients(line_user_id) select distinct line_user_id from platform_private.frontdesk_staff where tenant_id=$1 and login_channel_id=$2 and status=''approved'' and oa_verified_at is not null on conflict (line_user_id) do nothing',t.runtime_schema) using t.id,t.module_line->'booking'->'frontdesk'->>'loginChannelId';
  else
   execute format('delete from %I.frontdesk_notice_recipients where line_user_id is not null',t.runtime_schema);
  end if;
 end if;
 v:=jsonb_build_object('version',t.version,'frontdesk',coalesce(t.module_line->'booking'->'frontdesk','{}'),'staff',
  coalesce((select jsonb_agg(platform_private.frontdesk_staff_json(x) order by x.requested_at) from platform_private.frontdesk_staff x where x.tenant_id=t.id),'[]'));
 if p_action<>'get' then
  insert into platform_private.requests(request_id,actor,operation,payload_hash,result)values(rid,p_actor,'frontdesk:'||t.id||':'||p_action,hash,v);
  insert into platform_private.audit_events(actor,tenant_id,action,detail)values(p_actor,t.id,'FRONTDESK_'||upper(replace(p_action,'.','_')),jsonb_build_object('staffId',s.id,'status',p_body->>'status','permissionMode',p_body->>'permissionMode','result','success'));
 end if;return v;
end $$;
