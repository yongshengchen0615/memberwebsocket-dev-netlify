-- AC-FD-NOTIFY-001..006: Merchant-controlled self-service LINE notice pause.
-- Existing approved staff continue receiving until explicitly opting out.
alter table platform_private.frontdesk_staff
  add column if not exists allow_notification_toggle boolean not null default false,
  add column if not exists receive_notifications boolean not null default true;

create or replace function platform_private.frontdesk_staff_json(s platform_private.frontdesk_staff)
returns jsonb language sql immutable set search_path to ''
as $body$
 select jsonb_build_object(
  'id',s.id,'displayName',s.display_name,'status',s.status,
  'permissionMode',s.permission_mode,'allowNotificationToggle',s.allow_notification_toggle,
  'receiveNotifications',s.receive_notifications,'version',s.version,
  'requestedAt',s.requested_at,'reviewedAt',s.reviewed_at);
$body$;

-- Keep the current admin RPC's established merchant auth, optimistic version,
-- idempotency, audit and staff-recipient reconciliation instead of replacing it.
do $patch_admin$
declare d text; old_text text; new_text text;
begin
 select pg_get_functiondef('public.platform_frontdesk_admin(text,uuid,timestamptz,text,jsonb)'::regprocedure) into strict d;
 old_text:='if p_body->>''status''=''approved'' and s.oa_verified_at is null then';
 new_text:='if p_body ? ''allowNotificationToggle'' and jsonb_typeof(p_body->''allowNotificationToggle'') is distinct from ''boolean'' then raise exception ''PLATFORM_INVALID_INPUT'';end if;'||E'\n   '||old_text;
 if position(old_text in d)=0 then raise exception 'FRONTDESK_NOTIFY_ADMIN_VALIDATION_DRIFT';end if;
 d:=replace(d,old_text,new_text);

 old_text:='set status=p_body->>''status'',permission_mode=p_body->>''permissionMode'',version=version+1,';
 new_text:='set status=p_body->>''status'',permission_mode=p_body->>''permissionMode'',allow_notification_toggle=coalesce((p_body->>''allowNotificationToggle'')::boolean,allow_notification_toggle),version=version+1,';
 if position(old_text in d)=0 then raise exception 'FRONTDESK_NOTIFY_ADMIN_UPDATE_DRIFT';end if;
 d:=replace(d,old_text,new_text);

 old_text:='s.oa_verified_at is not null and s.line_user_id=r.line_user_id';
 new_text:='s.oa_verified_at is not null and s.receive_notifications and s.line_user_id=r.line_user_id';
 if position(old_text in d)=0 then raise exception 'FRONTDESK_NOTIFY_ADMIN_REMOVE_DRIFT';end if;
 d:=replace(d,old_text,new_text);

 old_text:='status=''''approved'''' and oa_verified_at is not null on conflict (line_user_id)';
 new_text:='status=''''approved'''' and oa_verified_at is not null and receive_notifications on conflict (line_user_id)';
 if position(old_text in d)=0 then raise exception 'FRONTDESK_NOTIFY_ADMIN_INSERT_DRIFT';end if;
 d:=replace(d,old_text,new_text);
 execute d;
end $patch_admin$;

-- Delivery-time guard protects queued jobs and avoids a client-only mute.
do $patch_delivery$
declare d text; old_text text;
begin
 select pg_get_functiondef('public.platform_frontdesk_delivery(uuid,text)'::regprocedure) into strict d;
 old_text:='s.id is not null and t.module_line';
 if position(old_text in d)=0 then raise exception 'FRONTDESK_NOTIFY_DELIVERY_DRIFT';end if;
 d:=replace(d,old_text,'s.id is not null and s.receive_notifications and t.module_line');
 execute d;
end $patch_delivery$;

-- Dedicated RPC: no access to booking privileges or admin-controlled toggle flag.
-- Invoked only with a provider-verified LINE identity and by service_role.
create or replace function public.platform_frontdesk_notification_preference(
 p_tenant_id uuid,p_actor text,p_channel_id text,p_issued_at timestamptz,p_enabled boolean
) returns jsonb language plpgsql set search_path to ''
as $body$
declare t platform_private.tenants; s platform_private.frontdesk_staff; cfg jsonb;
begin
 t:=platform_private.frontdesk_tenant(p_tenant_id);
 cfg:=t.module_line->'booking'->'frontdesk';
 if cfg->>'enabled' is distinct from 'true' then raise exception 'FRONTDESK_UNAVAILABLE';end if;
 if p_actor is null or p_actor!~'^U[0-9a-f]{32}$'
  or p_channel_id is distinct from cfg->>'loginChannelId'
  or p_issued_at is null or not isfinite(p_issued_at)
  or p_issued_at>clock_timestamp()+interval '60 seconds'
  or p_issued_at<=coalesce(t.access_revoked_before,'-infinity'::timestamptz)
  or p_issued_at<=coalesce((cfg->>'featureRevokedBefore')::timestamptz,'-infinity'::timestamptz)
 then raise exception 'FRONTDESK_AUTH_INVALID';end if;
 if p_enabled is null then raise exception 'PLATFORM_INVALID_INPUT';end if;
 select * into s from platform_private.frontdesk_staff
  where tenant_id=t.id and login_channel_id=p_channel_id and line_user_id=p_actor
  for update;
 if not found or s.status<>'approved' or s.oa_verified_at is null
  or p_issued_at<=coalesce(s.access_revoked_before,'-infinity'::timestamptz)
  or not s.allow_notification_toggle
 then raise exception 'FRONTDESK_NOTIFICATION_CONTROL_DENIED';end if;
 if s.receive_notifications is distinct from p_enabled then
  update platform_private.frontdesk_staff set receive_notifications=p_enabled,
   version=version+1,updated_at=clock_timestamp()
   where id=s.id returning * into s;
 end if;
 if not p_enabled then
  execute format('delete from %I.frontdesk_notice_recipients where line_user_id=$1',t.runtime_schema)
   using s.line_user_id;
  execute format('update %I.notice_outbox set status=''skipped'',last_error=''FRONTDESK_NOTIFICATIONS_PAUSED'' where channel=''frontdesk'' and recipient=$1 and status in (''pending'',''sending'')',t.runtime_schema)
   using s.line_user_id;
 else
  execute format('insert into %I.frontdesk_notice_recipients(line_user_id) values($1) on conflict (line_user_id) do nothing',t.runtime_schema)
   using s.line_user_id;
 end if;
 insert into platform_private.audit_events(actor,tenant_id,action,detail)
  values(p_actor,t.id,'FRONTDESK_NOTIFICATION_PREFERENCE',
   jsonb_build_object('staffId',s.id,'receiveNotifications',p_enabled,'result','success'));
 return jsonb_build_object('staff',platform_private.frontdesk_staff_json(s));
end $body$;

revoke all on function public.platform_frontdesk_notification_preference(uuid,text,text,timestamptz,boolean)
 from public,anon,authenticated;
grant execute on function public.platform_frontdesk_notification_preference(uuid,text,text,timestamptz,boolean)
 to service_role;
