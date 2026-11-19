-- Frontdesk is a separate default-deny super-admin grant. Existing eight-feature
-- tenants stay valid and cannot use frontdesk until explicitly granted.
-- The change never alters existing booking authorization or LINE credentials.
begin;
create or replace function public.platform_features_valid(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p) = 'object'
    and p ?& array['membership','points','events','calendar','integrations','booking','testing','usage']
    and (select count(*) from jsonb_object_keys(p)) = 8 + (case when p ? 'frontdesk' then 1 else 0 end)
    and not exists (select 1 from jsonb_each(p) where jsonb_typeof(value) <> 'boolean'), false)
$$;

create or replace function platform_private.frontdesk_tenant(p_id uuid) returns platform_private.tenants
language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;q platform_private.admin_qualifications;
begin
 -- Match the existing global lock order: qualification -> tenant -> staff -> booking.
 select * into t from platform_private.tenants where id=p_id;
 if not found then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 select * into q from platform_private.admin_qualifications where applicant_line_user_id=t.owner_line_user_id for share;
 if not found or q.status<>'approved' then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 select * into t from platform_private.tenants where id=p_id and owner_line_user_id=q.applicant_line_user_id for share;
 if not found or t.status<>'active' or t.runtime_schema is null or t.features->>'booking' is distinct from 'true'
  or t.features->>'frontdesk' is distinct from 'true'
  or t.expires_at<=clock_timestamp() then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 return t;
end $$;

create or replace function public.platform_frontdesk_admin(p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_action text,p_body jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;s platform_private.frontdesk_staff;r platform_private.requests;v jsonb;hash text;rid uuid;cfg jsonb;
begin
 t:=platform_private.require_merchant_access(p_actor,p_tenant_id,p_issued_at);
 if t.features->>'booking' is distinct from 'true' or t.features->>'frontdesk' is distinct from 'true' then raise exception 'FRONTDESK_UNAVAILABLE';end if;
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
  cfg:=jsonb_build_object('loginChannelId',p_body->>'loginChannelId','liffId',p_body->>'liffId','messagingChannelId',p_body->>'messagingChannelId','oaId',coalesce(p_body->>'oaId',cfg->>'oaId'),'revision',t.version+1,'enabled',(p_body->>'enabled')::boolean,'featureRevokedBefore',cfg->'featureRevokedBefore');
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

create or replace function public.platform_frontdesk_request(p_tenant_id uuid,p_actor text,p_channel_id text,p_issued_at timestamptz,p_action text,p_body jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
declare t platform_private.tenants;s platform_private.frontdesk_staff;cfg jsonb;v jsonb;b jsonb;bid uuid;rid uuid;hash text;r platform_private.requests;
begin
 t:=platform_private.frontdesk_tenant(p_tenant_id);cfg:=t.module_line->'booking'->'frontdesk';
 if cfg->>'enabled' is distinct from 'true' then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 if p_actor is null or p_actor!~'^U[0-9a-f]{32}$' or p_channel_id is distinct from cfg->>'loginChannelId' or p_issued_at is null or not isfinite(p_issued_at) or p_issued_at>clock_timestamp()+interval '60 seconds' or p_issued_at<=coalesce(t.access_revoked_before,'-infinity') or p_issued_at<=coalesce((cfg->>'featureRevokedBefore')::timestamptz,'-infinity') then raise exception 'FRONTDESK_AUTH_INVALID';end if;
 select * into s from platform_private.frontdesk_staff where tenant_id=t.id and login_channel_id=p_channel_id and line_user_id=p_actor for share;
 if p_action='apply' then
  if p_body->>'oaVerified' is distinct from 'true' then raise exception 'FRONTDESK_OA_REQUIRED';end if;
  if p_body->>'verifiedMessagingChannelId' is distinct from cfg->>'messagingChannelId' or p_body->'verifiedConfigRevision' is distinct from cfg->'revision' then raise exception 'FRONTDESK_OA_STALE';end if;
  insert into platform_private.frontdesk_staff(tenant_id,login_channel_id,line_user_id,display_name,oa_verified_at)
   values(t.id,p_channel_id,p_actor,left(coalesce(nullif(p_body->>'displayName',''),'櫃檯人員'),120),clock_timestamp()) on conflict(tenant_id,login_channel_id,line_user_id) do nothing;
  select * into s from platform_private.frontdesk_staff where tenant_id=t.id and login_channel_id=p_channel_id and line_user_id=p_actor;
  return jsonb_build_object('staff',platform_private.frontdesk_staff_json(s));
 end if;
 if p_action='bootstrap' then return jsonb_build_object('staff',case when s.id is null then null else platform_private.frontdesk_staff_json(s) end);end if;
 if s.id is null or s.status<>'approved' or s.permission_mode<>'review' or s.oa_verified_at is null then raise exception 'FRONTDESK_REVIEW_REQUIRED';end if;
 if p_issued_at<=coalesce(s.access_revoked_before,'-infinity') then raise exception 'FRONTDESK_AUTH_INVALID';end if;
 if p_action='bookings' then
  bid:=nullif(p_body->>'bookingId','')::uuid;
  execute format('select coalesce(jsonb_agg(platform_private.frontdesk_booking_json($1,x.id) order by x.start_at),''[]'') from (select id,start_at from %I.bookings where ($2::uuid is null and status=''pending'') or id=$2 order by start_at,id limit 50) x',t.runtime_schema) into v using t.runtime_schema,bid;
  return jsonb_build_object('bookings',v);
 end if;
 if p_action is distinct from 'booking.update' or coalesce(p_body->>'status','') not in ('confirmed','rejected') then raise exception 'PLATFORM_INVALID_INPUT';end if;
 bid:=(p_body->>'bookingId')::uuid;rid:=(p_body->>'requestId')::uuid;
 if bid is null or rid is null or nullif(p_body->>'expectedUpdatedAt','') is null then raise exception 'PLATFORM_INVALID_INPUT';end if;
 hash:=encode(sha256(convert_to((p_body-'requestId')::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(rid::text,0));
 select * into r from platform_private.requests where request_id=rid;
 if found then
  if r.actor<>p_actor or r.operation<>'frontdesk:booking:'||t.id or r.payload_hash<>hash then raise exception 'FRONTDESK_REQUEST_CONFLICT';end if;
  return r.result||'{"alreadyApplied":true}';
 end if;
 execute format('select to_jsonb(b) from %I.bookings b where id=$1 for update',t.runtime_schema) into b using bid;
 if b is null then raise exception 'FRONTDESK_NOT_FOUND';end if;
 if b->>'status'<>'pending' or (b->>'updated_at')::timestamptz is distinct from (p_body->>'expectedUpdatedAt')::timestamptz then raise exception 'BOOKING_CONFLICT';end if;
 if b->>'cancellation_requested_at' is not null and b->>'cancellation_reviewed_at' is null then raise exception 'BOOKING_CANCELLATION_PENDING';end if;
 execute format('update %I.bookings set status=$2,admin_note=coalesce($3,admin_note),%I=$4,%I=clock_timestamp() where id=$1',t.runtime_schema,case when p_body->>'status'='confirmed' then 'confirmed_by' else 'rejected_by' end,case when p_body->>'status'='confirmed' then 'confirmed_at' else 'rejected_at' end) using bid,p_body->>'status',left(p_body->>'note',500),p_actor;
 execute format('insert into %I.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata) values($1,''frontdesk'',$2,''booking'',$3,''success'',$4)',t.runtime_schema) using p_actor,'BOOKING_'||upper(p_body->>'status'),bid::text,jsonb_build_object('previousStatus','pending');
 v:=jsonb_build_object('booking',platform_private.frontdesk_booking_json(t.runtime_schema,bid),'alreadyApplied',false);
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)values(rid,p_actor,'frontdesk:booking:'||t.id,hash,v);
 return v;
end $$;

create or replace function public.platform_frontdesk_replay(p_actor text,p_tenant_id uuid,p_issued_at timestamptz,p_request_id uuid,p_hash text,p_action text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r platform_private.requests;begin
 perform platform_private.require_merchant_access(p_actor,p_tenant_id,p_issued_at);
 perform platform_private.frontdesk_tenant(p_tenant_id);
 select * into r from platform_private.requests where request_id=p_request_id;
 if not found then return null;end if;
 if r.actor<>p_actor or r.operation<>'frontdesk:'||p_tenant_id||':'||p_action or r.payload_hash<>p_hash then raise exception 'FRONTDESK_REQUEST_CONFLICT';end if;
 return r.result;
end $$;

create or replace function public.platform_update_tenant_features(
 p_actor text,p_tenant_id uuid,p_expected_version integer,p_features jsonb,
 p_request_id uuid,p_payload_hash text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 v_previous platform_private.requests;
 v_tenant platform_private.tenants;
 v_grants jsonb;
 v_revoked boolean;
begin
 if not public.platform_is_super_admin(p_actor) then raise exception 'PLATFORM_ADMIN_REQUIRED'; end if;
 if p_tenant_id is null or p_request_id is null or p_expected_version is null
  or p_expected_version < 1 or not coalesce(public.platform_features_valid(p_features),false)
  or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$'
 then raise exception 'PLATFORM_INVALID_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into v_previous from platform_private.requests where request_id=p_request_id;
 if found then
  if v_previous.actor<>p_actor or v_previous.operation<>'features'
   or v_previous.payload_hash<>p_payload_hash
  then raise exception 'PLATFORM_REQUEST_CONFLICT'; end if;
  return v_previous.result;
 end if;
 select * into v_tenant from platform_private.tenants where id=p_tenant_id for update;
 if not found then raise exception 'PLATFORM_TENANT_NOT_FOUND'; end if;
 if v_tenant.version<>p_expected_version then raise exception 'PLATFORM_CONFLICT'; end if;
 -- Preserve the previous eight grants; missing frontdesk is explicitly false.
 v_grants:=p_features||jsonb_build_object('frontdesk',coalesce(p_features->>'frontdesk'='true',false));
 v_revoked:=(coalesce(v_tenant.features->>'frontdesk'='true',false) and v_grants->>'frontdesk'='false')
  or (v_tenant.features->>'booking'='true' and v_grants->>'booking'='false');
 -- An entitlement revocation is atomic with outbox removal, staff token cutoff,
 -- and the new grant; the booking feature itself is otherwise untouched.
 update platform_private.tenants
 set features=v_grants,
 module_line=case when v_revoked and module_line->'booking'->'frontdesk' is not null
   then jsonb_set(module_line,'{booking,frontdesk}',module_line->'booking'->'frontdesk'
     ||jsonb_build_object('featureRevokedBefore',clock_timestamp()),true)
   else module_line end,
 version=version+1,updated_by=p_actor,updated_at=clock_timestamp()
 where id=p_tenant_id returning * into v_tenant;
 if v_revoked then
   update platform_private.frontdesk_staff
     set access_revoked_before=clock_timestamp(),updated_at=clock_timestamp()
     where tenant_id=p_tenant_id and status='approved';
 end if;
 if v_tenant.runtime_schema is not null and (v_grants->>'frontdesk' is distinct from 'true' or v_grants->>'booking' is distinct from 'true') then
   execute format('update %I.notice_outbox set status=''skipped'',last_error=''FRONTDESK_FEATURE_DISABLED'' where channel=''frontdesk'' and status in (''pending'',''sending'')',v_tenant.runtime_schema);
   execute format('delete from %I.frontdesk_notice_recipients where line_user_id is not null',v_tenant.runtime_schema);
 elsif v_tenant.runtime_schema is not null and v_tenant.module_line->'booking'->'frontdesk'->>'enabled'='true' then
   execute format('insert into %I.frontdesk_notice_recipients(line_user_id) select distinct line_user_id from platform_private.frontdesk_staff where tenant_id=$1 and login_channel_id=$2 and status=''approved'' and oa_verified_at is not null on conflict (line_user_id) do nothing',v_tenant.runtime_schema)
     using p_tenant_id,v_tenant.module_line->'booking'->'frontdesk'->>'loginChannelId';
 end if;
 insert into platform_private.audit_events(actor,tenant_id,action,detail)
 values(p_actor,p_tenant_id,'TENANT_FEATURES_UPDATED',
   jsonb_build_object('version',v_tenant.version,'features',v_grants));
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)
 values(p_request_id,p_actor,'features',p_payload_hash,to_jsonb(v_tenant));
 return to_jsonb(v_tenant);
end $$;

-- Keep the existing SECURITY INVOKER ownership and service_role-only RPC grants.
revoke all on function public.platform_features_valid(jsonb),public.platform_update_tenant_features(text,uuid,integer,jsonb,uuid,text),
 public.platform_frontdesk_admin(text,uuid,timestamptz,text,jsonb),public.platform_frontdesk_request(uuid,text,text,timestamptz,text,jsonb),
 public.platform_frontdesk_replay(text,uuid,timestamptz,uuid,text,text) from public,anon,authenticated;
grant execute on function public.platform_features_valid(jsonb),public.platform_update_tenant_features(text,uuid,integer,jsonb,uuid,text),
 public.platform_frontdesk_admin(text,uuid,timestamptz,text,jsonb),public.platform_frontdesk_request(uuid,text,text,timestamptz,text,jsonb),
 public.platform_frontdesk_replay(text,uuid,timestamptz,uuid,text,text) to service_role;
notify pgrst,'reload schema';
commit;
