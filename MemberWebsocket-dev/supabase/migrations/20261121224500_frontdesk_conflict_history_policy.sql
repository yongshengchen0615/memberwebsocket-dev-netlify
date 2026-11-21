-- AC-FD-CONFLICT-001..007: merchant-scoped frontdesk title/bounds and staff paired history.
-- Source: exact functions from Supabase test release of Integrated-Marketing-Platform.
-- Keep provider configuration and unrelated booking semantics intact.
-- All writes remain in the same tenant-scoped, role-validated DB transactions.

CREATE OR REPLACE FUNCTION platform_private.frontdesk_booking_json(p_schema text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v jsonb;
begin
 if p_schema !~ '^business_[0-9a-f]{32}$' then raise exception 'FRONTDESK_UNAVAILABLE'; end if;
 execute format($query$
 select jsonb_build_object(
   'id',b.id,'status',b.status,'updatedAt',b.updated_at,
   'bookingDate',b.booking_date,'startAt',b.start_at,'endAt',b.end_at,
   'totalDurationMinutes',b.total_duration_minutes,
   'startTime',left(b.start_time::text,5),'endTime',left(b.end_time::text,5),
   'name',coalesce(nullif(b.contact_surname,''),nullif(m.surname,''),'會員') ||
     case coalesce(nullif(b.contact_salutation,''),nullif(m.salutation,''),'')
       when 'mr' then '先生' when 'ms' then '小姐' else '' end,
   'phone',coalesce(nullif(b.contact_phone,''),m.phone,''),
   'partySize',b.party_size,'note',b.member_note,'adminNote',b.admin_note,
   'cancellationPending',b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null,
   'services',coalesce((select jsonb_agg(jsonb_build_object('title',i.service_title,'quantity',i.quantity)
                    order by i.created_at,i.id)
       from %1$I.booking_items i where i.booking_id=b.id),'[]'::jsonb),
   'participants',coalesce((
      select jsonb_agg(jsonb_build_object(
        'position',bp.position,
        'technician',coalesce(nullif(bt.name,''),'現場安排'),
        'note',bp.member_note,
        'services',coalesce((
          select jsonb_agg(jsonb_build_object('title',bpi.service_title,'quantity',bpi.quantity)
                    order by bpi.created_at,bpi.id)
          from %1$I.booking_participant_items bpi where bpi.participant_id=bp.id
        ),'[]'::jsonb)
      ) order by bp.position)
      from %1$I.booking_participants bp
      left join %1$I.booking_technicians bt on bt.id=bp.technician_id
      where bp.booking_id=b.id
   ),'[]'::jsonb),
   'fallbackTechnician',coalesce(nullif(fbt.name,''),'現場安排')
 )
 from %1$I.bookings b
 left join %1$I.members m on m.id=b.member_id
 left join %1$I.booking_technicians fbt on fbt.id=b.technician_id
 where b.id=$1
 $query$,p_schema) into v using p_id;
 return v;
end $function$;

CREATE OR REPLACE FUNCTION public.platform_frontdesk_admin(p_actor text, p_tenant_id uuid, p_issued_at timestamp with time zone, p_action text, p_body jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare t platform_private.tenants;s platform_private.frontdesk_staff;r platform_private.requests;v jsonb;hash text;rid uuid;cfg jsonb;pref jsonb;low_time integer;high_time integer;low_duration integer;high_duration integer;
begin
 t:=platform_private.require_merchant_access(p_actor,p_tenant_id,p_issued_at);
 if t.features->>'booking' is distinct from 'true' or t.features->>'frontdesk' is distinct from 'true' then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 if p_action not in ('get','settings.save','preferences.save','staff.save','staff.delete') or p_action is null then raise exception 'PLATFORM_INVALID_INPUT';end if;
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
  cfg:=coalesce(cfg,'{}'::jsonb)||jsonb_build_object('loginChannelId',p_body->>'loginChannelId','liffId',p_body->>'liffId','messagingChannelId',p_body->>'messagingChannelId','oaId',coalesce(p_body->>'oaId',cfg->>'oaId'),'revision',t.version+1,'enabled',(p_body->>'enabled')::boolean,'featureRevokedBefore',cfg->'featureRevokedBefore');
  if not(t.module_line ? 'booking') and t.credentials_configured then
   insert into platform_private.module_secrets(tenant_id,feature,envelope,credential_scope)
    select t.id,'booking',x.envelope,'tenant' from platform_private.tenant_secrets x where x.tenant_id=t.id
    on conflict(tenant_id,feature) do nothing;
  end if;
  insert into platform_private.module_notification_routes(tenant_id,feature,purpose,mode,channel_id,envelope,verified_at)
   values(t.id,'booking','frontdesk',case when (p_body->>'enabled')::boolean then 'custom' else 'disabled' end,p_body->>'messagingChannelId',p_body->'envelope',clock_timestamp())
   on conflict(tenant_id,feature,purpose) do update set mode=excluded.mode,channel_id=excluded.channel_id,envelope=coalesce(nullif(excluded.envelope,'null'),module_notification_routes.envelope),verified_at=excluded.verified_at,updated_at=clock_timestamp();
  update platform_private.tenants set module_line=jsonb_set(module_line,'{booking}',coalesce(module_line->'booking',jsonb_build_object('line',line_config,'credentialsConfigured',credentials_configured))||jsonb_build_object('frontdesk',cfg,'notifications',coalesce(module_line->'booking'->'notifications','{}')||jsonb_build_object('frontdesk',jsonb_build_object('mode',case when (p_body->>'enabled')::boolean then 'custom' else 'disabled' end,'channelId',p_body->>'messagingChannelId','verifiedAt',clock_timestamp())))),version=version+1,updated_at=clock_timestamp(),updated_by=p_actor where id=t.id returning * into t;

 elsif p_action='preferences.save' then
  -- No provider token is required; the existing merchant authorization,
  -- replay protection and optimistic tenant version checks still apply.
  if (p_body->>'expectedVersion')::integer is distinct from t.version then raise exception 'PLATFORM_CONFLICT';end if;
  pref:=p_body->'preferences';
  if jsonb_typeof(pref) is distinct from 'object'
   or jsonb_typeof(pref->'pageTitle') is distinct from 'string'
   or length(pref->>'pageTitle')>60 or (pref->>'pageTitle') ~ '[[:cntrl:]]'
   or coalesce(pref->>'conflictStartMin','') !~ '^(0|[1-9][0-9]{0,3})
  -- Lock the existing application, validate its optimistic version and revoke
  -- every tenant-scoped frontdesk entitlement in the same transaction.
  select * into s from platform_private.frontdesk_staff
   where id=(p_body->>'staffId')::uuid and tenant_id=t.id for update;
  if not found then raise exception 'FRONTDESK_NOT_FOUND';end if;
  if s.version is distinct from (p_body->>'expectedVersion')::integer then raise exception 'PLATFORM_CONFLICT';end if;
  -- Delete frontdesk-specific deliveries and subscription; do not delete bookings.
  execute format('delete from %I.notice_outbox where channel=''frontdesk'' and recipient=$1',t.runtime_schema)
   using s.line_user_id;
  execute format('delete from %I.frontdesk_notice_recipients where line_user_id=$1',t.runtime_schema)
   using s.line_user_id;
  -- Remove applicant's sensitive booking-response replay cache, retaining
  -- immutable merchant booking and audit history.
  delete from platform_private.requests
   where actor=s.line_user_id and operation='frontdesk:booking:'||t.id;
  -- Historical merchant idempotency snapshots must not re-expose removed staff.
  update platform_private.requests pr
   set result=jsonb_set(pr.result,'{staff}',coalesce(
    (select jsonb_agg(item) from jsonb_array_elements(pr.result->'staff') item
      where item->>'id'<>s.id::text),'[]'::jsonb))
   where pr.operation like 'frontdesk:'||t.id::text||':%'
     and jsonb_typeof(pr.result->'staff')='array'
     and pr.result->'staff' @> jsonb_build_array(jsonb_build_object('id',s.id));
  delete from platform_private.frontdesk_staff where id=s.id and tenant_id=t.id;
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
end $function$

   or coalesce(pref->>'conflictStartMax','') !~ '^(0|[1-9][0-9]{0,3})
  -- Lock the existing application, validate its optimistic version and revoke
  -- every tenant-scoped frontdesk entitlement in the same transaction.
  select * into s from platform_private.frontdesk_staff
   where id=(p_body->>'staffId')::uuid and tenant_id=t.id for update;
  if not found then raise exception 'FRONTDESK_NOT_FOUND';end if;
  if s.version is distinct from (p_body->>'expectedVersion')::integer then raise exception 'PLATFORM_CONFLICT';end if;
  -- Delete frontdesk-specific deliveries and subscription; do not delete bookings.
  execute format('delete from %I.notice_outbox where channel=''frontdesk'' and recipient=$1',t.runtime_schema)
   using s.line_user_id;
  execute format('delete from %I.frontdesk_notice_recipients where line_user_id=$1',t.runtime_schema)
   using s.line_user_id;
  -- Remove applicant's sensitive booking-response replay cache, retaining
  -- immutable merchant booking and audit history.
  delete from platform_private.requests
   where actor=s.line_user_id and operation='frontdesk:booking:'||t.id;
  -- Historical merchant idempotency snapshots must not re-expose removed staff.
  update platform_private.requests pr
   set result=jsonb_set(pr.result,'{staff}',coalesce(
    (select jsonb_agg(item) from jsonb_array_elements(pr.result->'staff') item
      where item->>'id'<>s.id::text),'[]'::jsonb))
   where pr.operation like 'frontdesk:'||t.id::text||':%'
     and jsonb_typeof(pr.result->'staff')='array'
     and pr.result->'staff' @> jsonb_build_array(jsonb_build_object('id',s.id));
  delete from platform_private.frontdesk_staff where id=s.id and tenant_id=t.id;
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
end $function$

   or coalesce(pref->>'conflictDurationMin','') !~ '^(0|[1-9][0-9]{0,3})
  -- Lock the existing application, validate its optimistic version and revoke
  -- every tenant-scoped frontdesk entitlement in the same transaction.
  select * into s from platform_private.frontdesk_staff
   where id=(p_body->>'staffId')::uuid and tenant_id=t.id for update;
  if not found then raise exception 'FRONTDESK_NOT_FOUND';end if;
  if s.version is distinct from (p_body->>'expectedVersion')::integer then raise exception 'PLATFORM_CONFLICT';end if;
  -- Delete frontdesk-specific deliveries and subscription; do not delete bookings.
  execute format('delete from %I.notice_outbox where channel=''frontdesk'' and recipient=$1',t.runtime_schema)
   using s.line_user_id;
  execute format('delete from %I.frontdesk_notice_recipients where line_user_id=$1',t.runtime_schema)
   using s.line_user_id;
  -- Remove applicant's sensitive booking-response replay cache, retaining
  -- immutable merchant booking and audit history.
  delete from platform_private.requests
   where actor=s.line_user_id and operation='frontdesk:booking:'||t.id;
  -- Historical merchant idempotency snapshots must not re-expose removed staff.
  update platform_private.requests pr
   set result=jsonb_set(pr.result,'{staff}',coalesce(
    (select jsonb_agg(item) from jsonb_array_elements(pr.result->'staff') item
      where item->>'id'<>s.id::text),'[]'::jsonb))
   where pr.operation like 'frontdesk:'||t.id::text||':%'
     and jsonb_typeof(pr.result->'staff')='array'
     and pr.result->'staff' @> jsonb_build_array(jsonb_build_object('id',s.id));
  delete from platform_private.frontdesk_staff where id=s.id and tenant_id=t.id;
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
end $function$

   or coalesce(pref->>'conflictDurationMax','') !~ '^(0|[1-9][0-9]{0,3})
  -- Lock the existing application, validate its optimistic version and revoke
  -- every tenant-scoped frontdesk entitlement in the same transaction.
  select * into s from platform_private.frontdesk_staff
   where id=(p_body->>'staffId')::uuid and tenant_id=t.id for update;
  if not found then raise exception 'FRONTDESK_NOT_FOUND';end if;
  if s.version is distinct from (p_body->>'expectedVersion')::integer then raise exception 'PLATFORM_CONFLICT';end if;
  -- Delete frontdesk-specific deliveries and subscription; do not delete bookings.
  execute format('delete from %I.notice_outbox where channel=''frontdesk'' and recipient=$1',t.runtime_schema)
   using s.line_user_id;
  execute format('delete from %I.frontdesk_notice_recipients where line_user_id=$1',t.runtime_schema)
   using s.line_user_id;
  -- Remove applicant's sensitive booking-response replay cache, retaining
  -- immutable merchant booking and audit history.
  delete from platform_private.requests
   where actor=s.line_user_id and operation='frontdesk:booking:'||t.id;
  -- Historical merchant idempotency snapshots must not re-expose removed staff.
  update platform_private.requests pr
   set result=jsonb_set(pr.result,'{staff}',coalesce(
    (select jsonb_agg(item) from jsonb_array_elements(pr.result->'staff') item
      where item->>'id'<>s.id::text),'[]'::jsonb))
   where pr.operation like 'frontdesk:'||t.id::text||':%'
     and jsonb_typeof(pr.result->'staff')='array'
     and pr.result->'staff' @> jsonb_build_array(jsonb_build_object('id',s.id));
  delete from platform_private.frontdesk_staff where id=s.id and tenant_id=t.id;
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
end $function$

  then raise exception 'PLATFORM_INVALID_INPUT';end if;
  low_time:=(pref->>'conflictStartMin')::integer;
  high_time:=(pref->>'conflictStartMax')::integer;
  low_duration:=(pref->>'conflictDurationMin')::integer;
  high_duration:=(pref->>'conflictDurationMax')::integer;
  if low_time<0 or high_time>1430 or low_time>high_time
   or low_duration<10 or high_duration>1430 or low_duration>high_duration
   or low_time%10<>0 or high_time%10<>0
   or low_duration%10<>0 or high_duration%10<>0
  then raise exception 'PLATFORM_INVALID_INPUT';end if;
  pref:=jsonb_build_object('pageTitle',btrim(pref->>'pageTitle'),
   'conflictStartMin',low_time,'conflictStartMax',high_time,
   'conflictDurationMin',low_duration,'conflictDurationMax',high_duration);
  update platform_private.tenants
    set module_line=jsonb_set(coalesce(module_line,'{}'::jsonb),'{booking}',
      coalesce(module_line->'booking','{}'::jsonb)||jsonb_build_object(
        'frontdesk',coalesce(module_line#>'{booking,frontdesk}','{}'::jsonb)||pref),true),
      version=version+1,updated_at=clock_timestamp(),updated_by=p_actor
    where id=t.id and version=t.version returning * into t;
  if not found then raise exception 'PLATFORM_CONFLICT';end if;
 elsif p_action='staff.delete' then
  -- Lock the existing application, validate its optimistic version and revoke
  -- every tenant-scoped frontdesk entitlement in the same transaction.
  select * into s from platform_private.frontdesk_staff
   where id=(p_body->>'staffId')::uuid and tenant_id=t.id for update;
  if not found then raise exception 'FRONTDESK_NOT_FOUND';end if;
  if s.version is distinct from (p_body->>'expectedVersion')::integer then raise exception 'PLATFORM_CONFLICT';end if;
  -- Delete frontdesk-specific deliveries and subscription; do not delete bookings.
  execute format('delete from %I.notice_outbox where channel=''frontdesk'' and recipient=$1',t.runtime_schema)
   using s.line_user_id;
  execute format('delete from %I.frontdesk_notice_recipients where line_user_id=$1',t.runtime_schema)
   using s.line_user_id;
  -- Remove applicant's sensitive booking-response replay cache, retaining
  -- immutable merchant booking and audit history.
  delete from platform_private.requests
   where actor=s.line_user_id and operation='frontdesk:booking:'||t.id;
  -- Historical merchant idempotency snapshots must not re-expose removed staff.
  update platform_private.requests pr
   set result=jsonb_set(pr.result,'{staff}',coalesce(
    (select jsonb_agg(item) from jsonb_array_elements(pr.result->'staff') item
      where item->>'id'<>s.id::text),'[]'::jsonb))
   where pr.operation like 'frontdesk:'||t.id::text||':%'
     and jsonb_typeof(pr.result->'staff')='array'
     and pr.result->'staff' @> jsonb_build_array(jsonb_build_object('id',s.id));
  delete from platform_private.frontdesk_staff where id=s.id and tenant_id=t.id;
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
end $function$;

CREATE OR REPLACE FUNCTION platform_private.frontdesk_create_duration_booking(p_schema text, p_request_id text, p_actor text, p_booking_date date, p_start_time time without time zone, p_duration integer, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_settings jsonb;v_store jsonb;v_saved jsonb;v_booking jsonb;
 v_start timestamp without time zone;v_fits boolean;v_participant uuid;
 v_store_id constant uuid:='00000000-0000-4000-8000-000000000010';
 v_note text:=coalesce(p_note,'');
 v_policy jsonb;v_clock integer;
begin
 if p_schema !~ '^business_[0-9a-f]{32}$'
    or not exists(select 1 from platform_private.tenants where runtime_schema=p_schema)
 then raise exception 'BUSINESS_SCHEMA_INVALID';end if;
 if not exists(
   select 1 from platform_private.frontdesk_staff f
   join platform_private.tenants t on t.id=f.tenant_id
   where t.runtime_schema=p_schema and f.line_user_id=p_actor
    and f.status='approved' and f.permission_mode='review'
    and f.oa_verified_at is not null
 ) then raise exception 'FRONTDESK_REVIEW_REQUIRED';end if;
 if p_request_id !~ '^PHONE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 then raise exception 'INVALID_REQUEST_ID';end if;
 if p_duration is null or p_duration not between 1 and 1439
 then raise exception 'INVALID_BOOKING_DURATION';end if;
 if p_booking_date is null or p_start_time is null
 then raise exception 'INVALID_BOOKING_SLOT';end if;
 if char_length(v_note)>500 then raise exception 'INVALID_BOOKING_NOTE';end if;

 -- Repeat the merchant's 10-minute policy on the authoritative SQL write
 -- boundary; the frontend dropdown is not a security boundary.
 select module_line#>'{booking,frontdesk}' into v_policy
 from platform_private.tenants where runtime_schema=p_schema;
 v_clock:=extract(hour from p_start_time)::integer*60
          +extract(minute from p_start_time)::integer;
 if extract(second from p_start_time)<>0 or v_clock%10<>0
  or p_duration%10<>0
  or v_clock<coalesce((v_policy->>'conflictStartMin')::integer,0)
  or v_clock>coalesce((v_policy->>'conflictStartMax')::integer,1430)
  or p_duration<coalesce((v_policy->>'conflictDurationMin')::integer,10)
  or p_duration>coalesce((v_policy->>'conflictDurationMax')::integer,1430)
 then raise exception 'FRONTDESK_CONFLICT_POLICY';end if;

 execute format('select %I.booking_price_context_time()',p_schema);
 execute format('select to_jsonb(x) from %I.booking_settings x where x.id=1 for share',p_schema)
  into v_settings;
 if v_settings is null then raise exception 'BOOKING_SETTINGS_MISSING';end if;
 execute format('select to_jsonb(x) from %I.booking_services x where x.id=$1 and x.is_active and x.deleted_at is null for share',p_schema)
  into v_store using v_store_id;
 if v_store is null then raise exception 'BOOKING_SERVICE_NOT_FOUND';end if;
 execute format('select %I.booking_slot_fits($1,$2,$3,$4,$5,$6)',p_schema)
  into v_fits using p_booking_date,p_start_time,p_duration,
    (v_settings->>'work_start_time')::time,(v_settings->>'work_end_time')::time,
    (v_settings->>'slot_interval_minutes')::integer;
 if v_fits is distinct from true then raise exception 'INVALID_BOOKING_SLOT';end if;
 execute format('select %I.booking_slot_start_at($1,$2,$3,$4)',p_schema)
  into v_start using p_booking_date,p_start_time,
    (v_settings->>'work_start_time')::time,(v_settings->>'work_end_time')::time;
 if v_start <= (clock_timestamp() at time zone 'Asia/Taipei')
 then raise exception 'BOOKING_TIME_PASSED';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id,0));
 execute format('select to_jsonb(x) from %I.bookings x where x.request_id=$1',p_schema)
  into v_saved using p_request_id;
 if v_saved is not null then raise exception 'REQUEST_ID_CONFLICT';end if;
 -- An operational placeholder is saved as a booking-item snapshot so downstream
 -- calendars and LINE notifications use the real held duration, without selling a service.
 execute format($insert$
   insert into %I.bookings as b(
    request_id,service_id,member_id,booking_date,start_time,end_time,
    total_duration_minutes,status,member_note,admin_note,
    contact_source,contact_surname,contact_salutation,contact_phone,
    technician_id,confirmed_by,confirmed_at
   ) values($1,$2,null,$3,$4,($4+make_interval(mins=>$5))::time,
    $5,'pending','',$6,'custom','現場','mr',null,null,null,null)
   returning to_jsonb(b)$insert$,p_schema)
  into v_booking using p_request_id,v_store_id,p_booking_date,p_start_time,p_duration,v_note;
 execute format('insert into %I.booking_participants(booking_id,position,technician_id) values($1,1,null) returning id',p_schema)
  into v_participant using (v_booking->>'id')::uuid;
 execute format($items$
   insert into %I.booking_items(
    booking_id,service_id,service_title,unit_duration_minutes,
    unit_price_amount,quantity,service_type,counts_toward_membership)
   values($1,$2,'現場預約時段',$3,0,1,$4,false)$items$,p_schema)
  using (v_booking->>'id')::uuid,v_store_id,p_duration,v_store->>'service_type';
 execute format($part$
   insert into %I.booking_participant_items(
    participant_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity)
   values($1,$2,'現場預約時段',$3,0,1)$part$,p_schema)
  using v_participant,v_store_id,p_duration;
 execute format($audit$
   insert into %I.booking_audit_events(
    actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
   values($1,'frontdesk','BOOKING_PHONE_CREATED','booking',$2,'success',
    jsonb_build_object('source','phone','partySize',1,'durationMinutes',$3))$audit$,p_schema)
  using p_actor,v_booking->>'id',p_duration;
 return v_booking;
exception when exclusion_violation then raise exception 'BOOKING_SLOT_TAKEN';
end $function$;

CREATE OR REPLACE FUNCTION public.platform_frontdesk_request(p_tenant_id uuid, p_actor text, p_channel_id text, p_issued_at timestamp with time zone, p_action text, p_body jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare t platform_private.tenants;s platform_private.frontdesk_staff;cfg jsonb;v jsonb;b jsonb;bid uuid;rid uuid;hash text;r platform_private.requests;notice_details text;notice_message text;store_service_minutes integer;fallback_items text;fallback_minutes integer;fallback_amount bigint;
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

 -- A private tenant revision, checked only after approved review authorization.
 if p_action='sync.status' then
   execute format('select coalesce(max(id),0)::text from %I.realtime_events where scope=''admin'' and event_type like ''booking.%%''',t.runtime_schema) into hash;
   return jsonb_build_object('revision',hash);
 end if;
 if p_action='phone.catalog' then
   return platform_private.frontdesk_phone_catalog(t.runtime_schema);
 end if;
 if p_action='phone.slots' then
   return platform_private.frontdesk_phone_slots(t.runtime_schema,p_body);
 end if;
 if p_action='phone.create' then
   execute format('select to_jsonb(%I.frontdesk_create_phone_booking_request($1,$2,$3,$4,$5,$6,$7,$8,$9))',t.runtime_schema)
     into v using p_body->>'requestId',p_actor,(p_body->>'bookingDate')::date,(p_body->>'startTime')::time,
       p_body->>'contactSurname',p_body->>'contactSalutation',p_body->>'contactPhone',
       p_body->'items',coalesce(p_body->>'adminNote','');
   return jsonb_build_object('bookingId',v->>'id','status',v->>'status');
 end if;
 if p_action='booking.reject_phone' then
   if p_body->>'status' is distinct from 'rejected'
      or p_body->>'rejectionReason' is distinct from 'unrecorded_phone_booking'
      or p_body->>'phoneRequestId' !~ '^PHONE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or p_body->>'requestId' is null or p_body->>'bookingId' is null
      or p_body->>'startTime' is null or p_body ? 'items'
      or (case when coalesce(p_body->>'totalDurationMinutes','') ~ '^[1-9][0-9]{0,3}$'
         then (p_body->>'totalDurationMinutes')::integer between 1 and 1439
         else false end) is not true
   then raise exception 'PLATFORM_INVALID_INPUT';end if;
   -- Never trust a client-supplied booking date or owner for replacement.
   execute format('select to_jsonb(b) from %I.bookings b where id=$1',t.runtime_schema)
      into b using (p_body->>'bookingId')::uuid;
   if b is null then raise exception 'FRONTDESK_NOT_FOUND';end if;
   -- Both operations run inside this function call's single transaction:
   -- a slot conflict or failed phone insert rolls back the rejection,
   -- its audit event, realtime event and deferred LINE notification together.
   -- Keep phoneRequestId/items/startTime in the underlying review request
   -- payload so the existing requestId hash forbids changing them on replay.
   v:=public.platform_frontdesk_request(p_tenant_id,p_actor,p_channel_id,p_issued_at,'booking.update',p_body);
   -- The original review request and replacement creation share one transaction.
   -- Only a verified replay may return a previously confirmed replacement.
   if coalesce((v->>'alreadyApplied')::boolean,false) then
     execute format('select to_jsonb(x) from %I.bookings x where x.request_id=$1',t.runtime_schema)
       into b using p_body->>'phoneRequestId';
     if b is null or b->>'status'<>'confirmed'
       or platform_private.frontdesk_paired_phone_source(t.runtime_schema,b)
          is distinct from (p_body->>'bookingId')::uuid then
       raise exception 'FRONTDESK_REQUEST_CONFLICT';
     end if;
     return v||jsonb_build_object('phoneBookingId',b->>'id','phoneBookingStatus',b->>'status');
   end if;
   b:=platform_private.frontdesk_create_duration_booking(
      t.runtime_schema,p_body->>'phoneRequestId',p_actor,
      (b->>'booking_date')::date,(p_body->>'startTime')::time,
      (p_body->>'totalDurationMinutes')::integer,
      '原預約 '||(p_body->>'bookingId')||' 拒絕後的現場／電話預約');
   -- The confirmed state, staff actor and exact display name are durable data,
   -- not merely a LINE presentation change. Preserve request-ID replay above.
   execute format('update %I.bookings x set status=''confirmed'',
       confirmed_by=$2,confirmed_at=clock_timestamp(),
       contact_surname=''櫃檯人員'',contact_salutation=null
       where x.id=$1 and x.status=''pending'' returning to_jsonb(x)',t.runtime_schema)
     into b using (b->>'id')::uuid,p_actor;
   if b is null then raise exception 'FRONTDESK_PHONE_CONFIRM_CONFLICT';end if;
   return v||jsonb_build_object('phoneBookingId',b->>'id','phoneBookingStatus',b->>'status');
 end if;

 if p_action='history' then
  -- Only review-authorized staff can reach this branch (staff guard above).
  -- Staff can inspect their own paired conflicts, never another tenant's.
  execute format($history$
   select coalesce(jsonb_agg(jsonb_build_object(
     'actionAt',e.created_at,
     'booking',case when b.id is null then null else platform_private.frontdesk_booking_json($1,b.id) end,
     'phoneBooking',(
       select platform_private.frontdesk_booking_json($1,p.id)
       from %1$I.booking_audit_events paired
       join %1$I.bookings p on p.id::text=paired.target_id
       where paired.actor_role='frontdesk'
         and paired.action='BOOKING_PHONE_CREATED'
         and paired.target_type='booking'
         and paired.actor_line_user_id=e.actor_line_user_id
         and paired.created_at=e.created_at
         and platform_private.frontdesk_paired_phone_source($1,to_jsonb(p))=b.id
       order by paired.id desc limit 1
     )
   ) order by e.id desc),'[]'::jsonb)
   from (
     select id,created_at,target_id,actor_line_user_id
     from %1$I.booking_audit_events
     where actor_role='frontdesk' and action='BOOKING_REJECTED'
       and target_type='booking' and result='success'
       and metadata->>'rejectionReason'='unrecorded_phone_booking'
       and actor_line_user_id=$2
     order by id desc limit 30
   ) e left join %1$I.bookings b on b.id::text=e.target_id
  $history$,t.runtime_schema) into v using t.runtime_schema,p_actor;
  return jsonb_build_object('items',coalesce(v,'[]'::jsonb));
 end if;
 if p_action='bookings' then
  bid:=nullif(p_body->>'bookingId','')::uuid;
  execute format('select coalesce(jsonb_agg(platform_private.frontdesk_booking_json($1,x.id) order by x.start_at),''[]'') from (select id,start_at from %I.bookings where ($2::uuid is null and status=''pending'') or id=$2 order by start_at,id limit 50) x',t.runtime_schema) into v using t.runtime_schema,bid;
  return jsonb_build_object('bookings',v);
 end if;
 if p_action is distinct from 'booking.update' or coalesce(p_body->>'status','') not in ('confirmed','rejected') then raise exception 'PLATFORM_INVALID_INPUT';end if;
 bid:=(p_body->>'bookingId')::uuid;rid:=(p_body->>'requestId')::uuid;
 if bid is null or rid is null or nullif(p_body->>'expectedUpdatedAt','') is null then raise exception 'PLATFORM_INVALID_INPUT';end if;
 if p_body->>'status'='rejected' then
   if p_body->>'rejectionReason' is null or p_body->>'rejectionReason' not in ('technician_leave','unrecorded_phone_booking') then
     raise exception 'BOOKING_REJECTION_REASON_REQUIRED';end if;
 elsif p_body ? 'rejectionReason' then raise exception 'BOOKING_REJECTION_REASON_REQUIRED';end if;
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
 execute format('update %I.bookings set status=$2,admin_note=coalesce($3,admin_note),rejection_reason=$5,%I=$4,%I=clock_timestamp() where id=$1',t.runtime_schema,case when p_body->>'status'='confirmed' then 'confirmed_by' else 'rejected_by' end,case when p_body->>'status'='confirmed' then 'confirmed_at' else 'rejected_at' end) using bid,p_body->>'status',left(p_body->>'note',500),p_actor,p_body->>'rejectionReason';
 execute format('insert into %I.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata) values($1,''frontdesk'',$2,''booking'',$3,''success'',$4)',t.runtime_schema) using p_actor,'BOOKING_'||upper(p_body->>'status'),bid::text,jsonb_build_object('previousStatus','pending','rejectionReason',p_body->>'rejectionReason');
 v:=jsonb_build_object('booking',platform_private.frontdesk_booking_json(t.runtime_schema,bid),'alreadyApplied',false);

 -- Frontdesk-only admin notification; member confirmation stays in the existing trigger.
 if p_body->>'status'='confirmed' then
   b:=v->'booking';
   -- Use stored participant-item snapshots, not the mutable service catalogue.
   -- Keep the duration/price rules identical to the existing booking LINE notice.
   execute format($stmt$
     select coalesce(sum(bi.unit_duration_minutes * greatest(coalesce(bi.quantity,1),1)),0)::integer
       from %1$I.booking_items bi
      where bi.booking_id=$1
        and bi.service_id='00000000-0000-4000-8000-000000000010'::uuid
   $stmt$,t.runtime_schema) into store_service_minutes using bid;

   execute format($stmt$
     select string_agg(
       case bp.position
         when 1 then '第一位預約' when 2 then '第二位預約'
         when 3 then '第三位預約' when 4 then '第四位預約'
         when 5 then '第五位預約' when 6 then '第六位預約'
         when 7 then '第七位預約' when 8 then '第八位預約'
         when 9 then '第九位預約' when 10 then '第十位預約'
         else '第 '||bp.position::text||' 位預約'
       end
       ||E'\n預約項目：'||coalesce(nullif(pi.items,''),'請至預約頁查看')
       ||E'\n個別時間：'||(coalesce(pi.service_minutes,0)
           +case when coalesce(pi.has_store_service,false) then 0 else $2 end)::text
           ||' 分鐘'
       ||case when $2>0 then '（含店內服務 '||$2::text||' 分鐘）' else '' end
       ||E'\n個別金額：NT$'||to_char(coalesce(pi.amount,0),'FM999,999,999,990')
       ||E'\n預約技師：'||coalesce(nullif(bt.name,''),'現場安排')
       ||case when nullif(btrim(bp.member_note),'') is not null
           then E'\n個別備註：'
             ||regexp_replace(left(btrim(bp.member_note),500),E'[\r\n]+',' ','g')
           else '' end,
       E'\n\n' order by bp.position
     )
       from %1$I.booking_participants bp
       left join %1$I.booking_technicians bt on bt.id=bp.technician_id
       left join lateral (
         select string_agg(bpi.service_title
                    ||case when greatest(coalesce(bpi.quantity,1),1)>1
                         then ' × '||greatest(coalesce(bpi.quantity,1),1)::text else '' end,
                    '、' order by bpi.created_at,bpi.id) as items,
                coalesce(bool_or(bpi.service_id='00000000-0000-4000-8000-000000000010'::uuid),false) as has_store_service,
                coalesce(sum(bpi.unit_duration_minutes * greatest(coalesce(bpi.quantity,1),1)),0)::integer as service_minutes,
                coalesce(sum(bpi.unit_price_amount * greatest(coalesce(bpi.quantity,1),1)),0)::bigint as amount
           from %1$I.booking_participant_items bpi
          where bpi.participant_id=bp.id
       ) pi on true
      where bp.booking_id=$1
   $stmt$,t.runtime_schema) into notice_details using bid,store_service_minutes;

   -- Historical single-person rows may have booking_items without participants.
   if notice_details is null then
     execute format($stmt$
       select string_agg(bi.service_title
                 ||case when greatest(coalesce(bi.quantity,1),1)>1
                     then ' × '||greatest(coalesce(bi.quantity,1),1)::text else '' end,
                 '、' order by bi.created_at,bi.id),
              coalesce(sum(bi.unit_duration_minutes * greatest(coalesce(bi.quantity,1),1)),0)::integer,
              coalesce(sum(bi.unit_price_amount * greatest(coalesce(bi.quantity,1),1)),0)::bigint
         from %1$I.booking_items bi
        where bi.booking_id=$1
          and bi.service_id<>'00000000-0000-4000-8000-000000000010'::uuid
     $stmt$,t.runtime_schema)
       into fallback_items,fallback_minutes,fallback_amount using bid;
     notice_details:='第一位預約'
       ||E'\n預約項目：'||coalesce(nullif(fallback_items,''),'請至預約頁查看')
       ||E'\n個別時間：'||(fallback_minutes+store_service_minutes)::text||' 分鐘'
       ||case when store_service_minutes>0
           then '（含店內服務 '||store_service_minutes::text||' 分鐘）' else '' end
       ||E'\n個別金額：NT$'||to_char(fallback_amount,'FM999,999,999,990')
       ||E'\n預約技師：'||coalesce(nullif(b->>'fallbackTechnician',''),'現場安排');
   end if;
   notice_message:='【櫃檯確認預約】'
      ||E'\n預約日期：'||coalesce(b->>'bookingDate','')
      ||E'\n預約時間：'||coalesce(b->>'startTime','')
      ||E'\n預約人：'||coalesce(b->>'name','')
      ||E'\n電話：'||coalesce(b->>'phone','')
      ||E'\n預約人數：'||coalesce(b->>'partySize','1')||' 位'
      ||case when nullif(btrim(coalesce(b->>'note','')),'') is not null
         then E'\n會員備註：'||left(btrim(b->>'note'),500) else '' end
      ||case when nullif(btrim(coalesce(b->>'adminNote','')),'') is not null
         then E'\n管理端說明：'||left(btrim(b->>'adminNote'),500) else '' end
      ||E'\n\n'||notice_details;
   execute format('insert into %I.notice_outbox(booking_id,event_key,channel,recipient,message_text)
        select $1,$2,''admin'',a.line_user_id,$3 from %I.admins a
        where a.status=''active'' and a.role=''admin'' and a.line_user_id ~ ''^U[0-9a-f]{32}$''
        on conflict (event_key,channel,recipient) do nothing',t.runtime_schema,t.runtime_schema)
        using bid,'frontdesk.confirmed:'||rid::text,left(notice_message,8000);
 end if;
 insert into platform_private.requests(request_id,actor,operation,payload_hash,result)values(rid,p_actor,'frontdesk:booking:'||t.id,hash,v);
 return v;
end $function$;

notify pgrst,'reload schema';
