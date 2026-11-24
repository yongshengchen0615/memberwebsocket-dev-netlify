-- Issue #425 / AC-001..008. Additive, tenant-scoped configurable rejection reasons.
-- The existing booking.rejection_reason remains a legacy INTERNAL transaction code.
-- Custom reason labels and customer-facing text are immutable booking snapshots.
-- Apply only after the 20261122 frontdesk conflict/history migrations.

create or replace function platform_private.frontdesk_rejection_defaults()
returns jsonb language sql immutable set search_path='' as $defaults$
 select jsonb_build_object(
  'dropdownTitle','請選擇拒絕原因',
  'reasons',jsonb_build_array(
   jsonb_build_object('id','technician_leave','label','預約中有休假技師','requiresConflictTime',false,'memberDescription','預約中有休假技師','enabled',true),
   jsonb_build_object('id','unrecorded_phone_booking','label','該時段已被現場人員預約但未登記','requiresConflictTime',true,'memberDescription','該時段已被現場人員預約但未登記','enabled',true)
  )
 );
$defaults$;
revoke all on function platform_private.frontdesk_rejection_defaults() from public,anon,authenticated;
grant execute on function platform_private.frontdesk_rejection_defaults() to service_role;

create or replace function platform_private.validate_frontdesk_rejection_settings(
 p_next jsonb,p_previous jsonb
) returns jsonb language plpgsql set search_path='' as $validate$
declare v_title text;v_reasons jsonb;v_item jsonb;v_prior jsonb;
 v_id text;v_label text;v_description text;v_ids text[]:=array[]::text[];
 v_labels text[]:=array[]::text[];v_enabled integer:=0;
begin
 if jsonb_typeof(p_next) is distinct from 'object'
   or (p_next - 'dropdownTitle' - 'reasons') <> '{}'::jsonb
   or jsonb_typeof(p_next->'dropdownTitle') is distinct from 'string'
   or jsonb_typeof(p_next->'reasons') is distinct from 'array'
 then raise exception 'PLATFORM_INVALID_INPUT';end if;
 v_title:=btrim(p_next->>'dropdownTitle');
 if char_length(v_title)>60 or v_title ~ '[[:cntrl:]]'
 then raise exception 'PLATFORM_INVALID_INPUT';end if;
 if v_title='' then v_title:='請選擇拒絕原因';end if;
 v_reasons:=p_next->'reasons';
 if jsonb_array_length(v_reasons)<1 or jsonb_array_length(v_reasons)>30 then
   raise exception 'PLATFORM_INVALID_INPUT';end if;
 for v_item in select value from jsonb_array_elements(v_reasons) loop
  if jsonb_typeof(v_item) is distinct from 'object'
   or (v_item - 'id' - 'label' - 'requiresConflictTime' - 'memberDescription' - 'enabled') <> '{}'::jsonb
   or jsonb_typeof(v_item->'id') is distinct from 'string'
   or jsonb_typeof(v_item->'label') is distinct from 'string'
   or jsonb_typeof(v_item->'memberDescription') is distinct from 'string'
   or jsonb_typeof(v_item->'requiresConflictTime') is distinct from 'boolean'
   or jsonb_typeof(v_item->'enabled') is distinct from 'boolean'
  then raise exception 'PLATFORM_INVALID_INPUT';end if;
  v_id:=v_item->>'id';
  if v_id not in ('technician_leave','unrecorded_phone_booking')
   and v_id !~ '^custom_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then raise exception 'PLATFORM_INVALID_INPUT';end if;
  if v_id=any(v_ids) then raise exception 'PLATFORM_INVALID_INPUT';end if;
  v_ids:=array_append(v_ids,v_id);
  v_label:=btrim(v_item->>'label');v_description:=btrim(v_item->>'memberDescription');
  if char_length(v_label)<1 or char_length(v_label)>120 or v_label ~ '[[:cntrl:]]'
    or char_length(v_description)<1 or char_length(v_description)>400
    or replace(v_description,chr(10),'') ~ '[[:cntrl:]]'
  then raise exception 'PLATFORM_INVALID_INPUT';end if;
  if (v_item->>'enabled')::boolean then
   v_enabled:=v_enabled+1;
   if v_label=any(v_labels) then raise exception 'PLATFORM_INVALID_INPUT';end if;
   v_labels:=array_append(v_labels,v_label);
  end if;
 end loop;
 if v_enabled=0 then raise exception 'PLATFORM_INVALID_INPUT';end if;
 for v_prior in select value from jsonb_array_elements(
   coalesce(p_previous,platform_private.frontdesk_rejection_defaults())->'reasons'
 ) loop
  if not(v_prior->>'id'=any(v_ids)) then
   raise exception 'REJECTION_REASON_DELETE_FORBIDDEN';end if;
 end loop;
 return jsonb_build_object('dropdownTitle',v_title,'reasons',v_reasons);
end $validate$;
revoke all on function platform_private.validate_frontdesk_rejection_settings(jsonb,jsonb) from public,anon,authenticated;
grant execute on function platform_private.validate_frontdesk_rejection_settings(jsonb,jsonb) to service_role;

-- Add nullable snapshots, preserving all existing rows and legacy constraints.
alter table public.bookings
 add column if not exists rejection_reason_id text,
 add column if not exists rejection_reason_label text,
 add column if not exists rejection_member_description text;

do $extend_booking_schemas$
declare t record;d text;old_sql text;new_sql text;
begin
 for t in select runtime_schema from platform_private.tenants where runtime_schema is not null loop
  if t.runtime_schema !~ '^business_[0-9a-f]{32}$' then
   raise exception 'FRONTDESK_REJECTION_INVALID_SCHEMA';end if;
  execute format('alter table %I.bookings add column if not exists rejection_reason_id text, add column if not exists rejection_reason_label text, add column if not exists rejection_member_description text',t.runtime_schema);
 end loop;
 -- New merchant schemas receive these columns before the rejection trigger is installed.
 select pg_get_functiondef('platform_private.install_booking_rejection(text)'::regprocedure) into strict d;
 old_sql:='execute format(''alter table %I.bookings add column if not exists rejection_reason text'',p_schema);';
 new_sql:=old_sql||E'\n execute format(''alter table %I.bookings add column if not exists rejection_reason_id text, add column if not exists rejection_reason_label text, add column if not exists rejection_member_description text'',p_schema);';
 if (length(d)-length(replace(d,old_sql,'')))<>length(old_sql) then
  raise exception 'FRONTDESK_REJECTION_INSTALLER_CONTRACT_CHANGED';end if;
 execute replace(d,old_sql,new_sql);
end $extend_booking_schemas$;

-- Admin writes stay in the original merchant-authenticated, optimistic-version,
-- replay-safe transaction; the response alone advertises the new editor capability.
do $patch_frontdesk_admin$
declare d text;old_sql text;new_sql text;
begin
 select pg_get_functiondef('public.platform_frontdesk_admin(text,uuid,timestamptz,text,jsonb)'::regprocedure) into strict d;
 old_sql:='(''get'',''settings.save'',''preferences.save'',''staff.save'',''staff.delete'')';
 new_sql:='(''get'',''settings.save'',''preferences.save'',''rejection-settings.save'',''staff.save'',''staff.delete'')';
 if (length(d)-length(replace(d,old_sql,'')))<>length(old_sql) then raise exception 'FRONTDESK_ADMIN_ACTION_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='elsif p_action=''staff.delete'' then';
 new_sql:=$branch$elsif p_action='rejection-settings.save' then
  if (p_body->>'expectedVersion')::integer is distinct from t.version then raise exception 'PLATFORM_CONFLICT';end if;
  pref:=platform_private.validate_frontdesk_rejection_settings(
   p_body->'rejectionSettings',
   coalesce(t.module_line#>'{booking,frontdesk,rejectionSettings}',platform_private.frontdesk_rejection_defaults())
  );
  update platform_private.tenants
    set module_line=jsonb_set(coalesce(module_line,'{}'::jsonb),'{booking}',
      coalesce(module_line->'booking','{}'::jsonb)||jsonb_build_object(
        'frontdesk',coalesce(module_line#>'{booking,frontdesk}','{}'::jsonb)||jsonb_build_object('rejectionSettings',pref)),true),
      version=version+1,updated_at=clock_timestamp(),updated_by=p_actor
    where id=t.id and version=t.version returning * into t;
  if not found then raise exception 'PLATFORM_CONFLICT';end if;
 elsif p_action='staff.delete' then$branch$;
 if (length(d)-length(replace(d,old_sql,'')))<>length(old_sql) then raise exception 'FRONTDESK_ADMIN_SAVE_CONTRACT_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='''frontdesk'',coalesce(t.module_line->''booking''->''frontdesk'',''{}'')';
 new_sql:='''frontdesk'',coalesce(t.module_line->''booking''->''frontdesk'',''{}'')||jsonb_build_object(''rejectionSettings'',coalesce(t.module_line#>''{booking,frontdesk,rejectionSettings}'',platform_private.frontdesk_rejection_defaults()))';
 if (length(d)-length(replace(d,old_sql,'')))<>length(old_sql) then raise exception 'FRONTDESK_ADMIN_GET_CONTRACT_CHANGED';end if;
 execute replace(d,old_sql,new_sql);
end $patch_frontdesk_admin$;

-- Public bootstrap never advertises private reasons; only approved staff sees
-- them in "bookings" (after the existing SQL authorization guard).
do $patch_frontdesk_public_context$
declare d text;old_sql text;new_sql text;
begin
 select pg_get_functiondef('public.platform_frontdesk_context(text)'::regprocedure) into strict d;
 old_sql:='''frontdesk'',coalesce(t.module_line->''booking''->''frontdesk'',''{}'')';
 new_sql:='''frontdesk'',(coalesce(t.module_line->''booking''->''frontdesk'',''{}'') - ''rejectionSettings'')';
 if (length(d)-length(replace(d,old_sql,'')))<>length(old_sql) then raise exception 'FRONTDESK_PUBLIC_CONTEXT_CHANGED';end if;
 execute replace(d,old_sql,new_sql);
end $patch_frontdesk_public_context$;

do $patch_frontdesk_requests$
declare d text;old_sql text;new_sql text;
begin
 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamptz,text,jsonb)'::regprocedure) into strict d;
 old_sql:='return jsonb_build_object(''bookings'',v);';
 new_sql:='return jsonb_build_object(''bookings'',v,''rejectionSettings'',coalesce(t.module_line#>''{booking,frontdesk,rejectionSettings}'',platform_private.frontdesk_rejection_defaults()));';
 if (length(d)-length(replace(d,old_sql,'')))<>length(old_sql) then raise exception 'FRONTDESK_BOOKINGS_RESPONSE_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='rejection_reason=$5,%I=$4';
 new_sql:='rejection_reason=$5,rejection_reason_id=$6,rejection_reason_label=$7,rejection_member_description=$8,%I=$4';
 if (length(d)-length(replace(d,old_sql,'')))<>length(old_sql) then raise exception 'FRONTDESK_REJECTION_UPDATE_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='using bid,p_body->>''status'',left(p_body->>''note'',500),p_actor,p_body->>''rejectionReason'';';
 new_sql:='using bid,p_body->>''status'',left(p_body->>''note'',500),p_actor,p_body->>''rejectionReason'',p_body->>''rejectionReasonId'',p_body->>''rejectionReasonLabel'',p_body->>''rejectionMemberDescription'';';
 if (length(d)-length(replace(d,old_sql,'')))<>length(old_sql) then raise exception 'FRONTDESK_REJECTION_PARAMS_CHANGED';end if;
 d:=replace(d,old_sql,new_sql);
 old_sql:='''rejectionReason'',p_body->>''rejectionReason'')';
 new_sql:='''rejectionReason'',p_body->>''rejectionReason'',''rejectionReasonId'',p_body->>''rejectionReasonId'',''rejectionReasonLabel'',p_body->>''rejectionReasonLabel'')';
 if (length(d)-length(replace(d,old_sql,'')))<>length(old_sql) then raise exception 'FRONTDESK_REJECTION_AUDIT_CHANGED';end if;
 execute replace(d,old_sql,new_sql);
end $patch_frontdesk_requests$;

do $patch_booking_response$
declare d text;old_sql text;new_sql text;
begin
 select pg_get_functiondef('platform_private.frontdesk_booking_json(text,uuid)'::regprocedure) into strict d;
 old_sql:='''id'',b.id,''status'',b.status,''updatedAt'',b.updated_at,';
 new_sql:='''id'',b.id,''status'',b.status,''updatedAt'',b.updated_at,'||
  '''rejectionReason'',b.rejection_reason,''rejectionReasonId'',b.rejection_reason_id,'||
  '''rejectionReasonLabel'',b.rejection_reason_label,''rejectionMemberDescription'',b.rejection_member_description,';
 if (length(d)-length(replace(d,old_sql,'')))<>length(old_sql) then raise exception 'FRONTDESK_BOOKING_JSON_CONTRACT_CHANGED';end if;
 execute replace(d,old_sql,new_sql);
end $patch_booking_response$;

-- Continue to send exactly ONE member LINE rejection notice through the
-- existing deferred outbox. Prefer the stored customer-facing snapshot.
do $patch_rejection_notification$
declare d text;start_pos integer;end_pos integer;new_sql text;
begin
 select pg_get_functiondef('platform_private.append_booking_rejection_notice()'::regprocedure) into strict d;
 start_pos:=position('v_reason:=case NEW.rejection_reason' in d);
 end_pos:=position('execute format(''select rejection_message' in d);
 if start_pos=0 or end_pos<=start_pos then raise exception 'FRONTDESK_REJECTION_NOTICE_CONTRACT_CHANGED';end if;
 new_sql:=$notice$v_reason:=coalesce(nullif(NEW.rejection_reason_label,''),case NEW.rejection_reason
   when 'technician_leave' then '預約中有休假技師'
   when 'unrecorded_phone_booking' then '該時段已被現場人員預約但未登記'
   else null end);
 if nullif(btrim(coalesce(NEW.rejection_member_description,'')),'') is not null then
  v_reason:=coalesce(v_reason,'拒絕預約')||E'\n原因說明：'||NEW.rejection_member_description;
 end if;
 $notice$;
 execute substring(d from 1 for start_pos-1)||new_sql||substring(d from end_pos);
end $patch_rejection_notification$;

-- The only new write route is service-role-only. It authenticates using the
-- existing frontdesk_request transaction, including current staff permission,
-- tenant isolation, timestamp, overlap, booking state, audit and idempotency.
create or replace function public.platform_frontdesk_rejection_request(
 p_tenant_id uuid,p_actor text,p_channel_id text,p_issued_at timestamptz,
 p_action text,p_body jsonb
) returns jsonb language plpgsql security definer set search_path='' as $rejection$
declare t platform_private.tenants;v_policy jsonb;v_reason jsonb;v_original jsonb;
 v_saved platform_private.requests;v_id text;v_mapped text;v_payload jsonb;v_paired boolean;
 v_request uuid;
begin
 if p_action not in ('booking.update','booking.reject_phone')
   or jsonb_typeof(p_body) is distinct from 'object'
   or p_body->>'status' is distinct from 'rejected'
   or coalesce(p_body->>'rejectionReason','') !~ '^(technician_leave|unrecorded_phone_booking|custom_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
   or coalesce(p_body->>'requestId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 then raise exception 'BOOKING_REJECTION_REASON_REQUIRED';end if;
 v_id:=p_body->>'rejectionReason';v_paired:=(p_action='booking.reject_phone');
 v_request:=(p_body->>'requestId')::uuid;
 -- A verified replay must retain the original, durable reason snapshot even
 -- if a manager renamed or disabled that reason meanwhile.
 t:=platform_private.frontdesk_tenant(p_tenant_id);
 select * into v_saved from platform_private.requests where request_id=v_request;
 if found and v_saved.actor=p_actor and v_saved.operation='frontdesk:booking:'||t.id then
  v_original:=v_saved.result->'booking';
  if nullif(v_original->>'rejectionReasonId','') is not null then
   if v_original->>'rejectionReasonId' is distinct from v_id then raise exception 'FRONTDESK_REQUEST_CONFLICT';end if;
   v_mapped:=v_original->>'rejectionReason';
   v_payload:=p_body||jsonb_build_object(
    'rejectionReason',v_mapped,'rejectionReasonId',v_id,
    'rejectionReasonLabel',v_original->>'rejectionReasonLabel',
    'rejectionMemberDescription',v_original->>'rejectionMemberDescription');
  else
   -- Old requests did not have custom IDs; retain original legacy hash.
   if v_id not in ('technician_leave','unrecorded_phone_booking') then raise exception 'FRONTDESK_REQUEST_CONFLICT';end if;
   v_mapped:=v_id;v_payload:=p_body;
  end if;
 else
  v_policy:=coalesce(t.module_line#>'{booking,frontdesk,rejectionSettings}',platform_private.frontdesk_rejection_defaults());
  select value into v_reason from jsonb_array_elements(v_policy->'reasons')
    where value->>'id'=v_id and value->>'enabled'='true';
  if v_reason is null then raise exception 'REJECTION_REASON_DISABLED';end if;
  if (v_reason->>'requiresConflictTime')::boolean is distinct from v_paired then
    raise exception 'REJECTION_ROUTE_MISMATCH';end if;
  if not v_paired and (p_body ? 'phoneRequestId' or p_body ? 'startTime' or p_body ? 'totalDurationMinutes') then
    raise exception 'REJECTION_ROUTE_MISMATCH';end if;
  v_mapped:=case when v_paired then 'unrecorded_phone_booking' else 'technician_leave' end;
  v_payload:=p_body||jsonb_build_object(
   'rejectionReason',v_mapped,'rejectionReasonId',v_id,
   'rejectionReasonLabel',v_reason->>'label',
   'rejectionMemberDescription',v_reason->>'memberDescription');
 end if;
 if (v_mapped='unrecorded_phone_booking') is distinct from v_paired
 then raise exception 'REJECTION_ROUTE_MISMATCH';end if;
 return public.platform_frontdesk_request(
  p_tenant_id,p_actor,p_channel_id,p_issued_at,p_action,v_payload
 );
end $rejection$;
revoke all on function public.platform_frontdesk_rejection_request(uuid,text,text,timestamptz,text,jsonb) from public,anon,authenticated;
grant execute on function public.platform_frontdesk_rejection_request(uuid,text,text,timestamptz,text,jsonb) to service_role;
notify pgrst,'reload schema';
