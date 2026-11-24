-- AC-VAC-001..008: per-reason technician vacation selection, tenant-scoped.
-- This migration extends the existing configurable rejection workflow after
-- 20261124120000. No member or technician records are modified.
-- Prior tenant policies without hasVacationTechnicians remain opt-out.
do $rejection_policy_field$
declare d text;before text;after text;
begin
 select pg_get_functiondef('platform_private.validate_frontdesk_rejection_settings(jsonb,jsonb)'::regprocedure) into strict d;
 before:='(v_item - ''id'' - ''label'' - ''requiresConflictTime'' - ''memberDescription'' - ''enabled'')';
 after:='(v_item - ''id'' - ''label'' - ''requiresConflictTime'' - ''memberDescription'' - ''enabled'' - ''hasVacationTechnicians'')';
 if length(d)-length(replace(d,before,''))<>length(before) then
  raise exception 'VACATION_POLICY_FIELD_CONTRACT_CHANGED';end if;
 d:=replace(d,before,after);
 before:='or jsonb_typeof(v_item->''enabled'') is distinct from ''boolean''';
 after:=before||E'\n   or (v_item ? ''hasVacationTechnicians'' and jsonb_typeof(v_item->''hasVacationTechnicians'') is distinct from ''boolean'')';
 if length(d)-length(replace(d,before,''))<>length(before) then
  raise exception 'VACATION_POLICY_TYPE_CONTRACT_CHANGED';end if;
 execute replace(d,before,after);
end $rejection_policy_field$;

-- Service-role only. These catalog values are only returned via the existing
-- staff-authenticated "bookings" branch of platform_frontdesk_request.
create or replace function platform_private.frontdesk_active_technicians(p_schema text)
returns jsonb language plpgsql stable set search_path='' as $catalog$
declare v_result jsonb;
begin
 if p_schema is null or p_schema !~ '^business_[0-9a-f]{32}$' then
  raise exception 'FRONTDESK_REJECTION_INVALID_SCHEMA';end if;
 execute format($q$
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',left(btrim(name),80))
    order by sort_order,name,id),'[]'::jsonb)
  from %I.booking_technicians where is_active=true
 $q$,p_schema) into v_result;
 return coalesce(v_result,'[]'::jsonb);
end $catalog$;
revoke all on function platform_private.frontdesk_active_technicians(text) from public,anon,authenticated;
grant execute on function platform_private.frontdesk_active_technicians(text) to service_role;

create or replace function platform_private.frontdesk_vacation_names(p_schema text,p_ids jsonb)
returns text[] language plpgsql stable set search_path='' as $names$
declare v_names text[];
begin
 if p_schema is null or p_schema !~ '^business_[0-9a-f]{32}$' then
  raise exception 'FRONTDESK_REJECTION_INVALID_SCHEMA';end if;
 execute format($q$
  select coalesce(array_agg(left(btrim(t.name),80) order by s.ordinality),array[]::text[])
  from jsonb_array_elements_text($1) with ordinality s(id,ordinality)
  join %I.booking_technicians t on t.id=s.id::uuid and t.is_active=true
 $q$,p_schema) into v_names using p_ids;
 return v_names;
end $names$;
revoke all on function platform_private.frontdesk_vacation_names(text,jsonb) from public,anon,authenticated;
grant execute on function platform_private.frontdesk_vacation_names(text,jsonb) to service_role;

do $frontdesk_vacation_catalog$
declare d text;before text;after text;
begin
 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamptz,text,jsonb)'::regprocedure) into strict d;
 before:='return jsonb_build_object(''bookings'',v,''rejectionSettings'',coalesce(t.module_line#>''{booking,frontdesk,rejectionSettings}'',platform_private.frontdesk_rejection_defaults()));';
 after:='return jsonb_build_object(''bookings'',v,''rejectionSettings'',coalesce(t.module_line#>''{booking,frontdesk,rejectionSettings}'',platform_private.frontdesk_rejection_defaults()),''technicians'',platform_private.frontdesk_active_technicians(t.runtime_schema));';
 if length(d)-length(replace(d,before,''))<>length(before) then
  raise exception 'VACATION_CATALOG_RESPONSE_CONTRACT_CHANGED';end if;
 execute replace(d,before,after);
end $frontdesk_vacation_catalog$;

-- The outer wrapper resolves names from the trusted current-tenant catalogue,
-- never from client labels. The existing locked review transaction stores the
-- generated member description snapshot and enforces request-hash replay.
create or replace function public.platform_frontdesk_rejection_request(
 p_tenant_id uuid,p_actor text,p_channel_id text,p_issued_at timestamptz,
 p_action text,p_body jsonb
) returns jsonb language plpgsql security definer set search_path='' as $rejection$
declare t platform_private.tenants;v_policy jsonb;v_reason jsonb;v_original jsonb;
 v_saved platform_private.requests;v_id text;v_mapped text;v_payload jsonb;v_paired boolean;
 v_request uuid;v_ids text[]:=array[]::text[];v_names text[];v_item text;
 v_description text;
begin
 if p_action not in ('booking.update','booking.reject_phone')
   or jsonb_typeof(p_body) is distinct from 'object'
   or p_body->>'status' is distinct from 'rejected'
   or coalesce(p_body->>'rejectionReason','') !~ '^(technician_leave|unrecorded_phone_booking|custom_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
   or coalesce(p_body->>'requestId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 then raise exception 'BOOKING_REJECTION_REASON_REQUIRED';end if;
 v_id:=p_body->>'rejectionReason';v_paired:=(p_action='booking.reject_phone');
 v_request:=(p_body->>'requestId')::uuid;

 if p_body ? 'vacationTechnicianIds' then
  if jsonb_typeof(p_body->'vacationTechnicianIds') is distinct from 'array'
    or jsonb_array_length(p_body->'vacationTechnicianIds')>10
  then raise exception 'VACATION_TECHNICIANS_INVALID';end if;
  for v_item in select value from jsonb_array_elements_text(p_body->'vacationTechnicianIds') loop
   if v_item !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or v_item=any(v_ids) then raise exception 'VACATION_TECHNICIANS_INVALID';end if;
   v_ids:=array_append(v_ids,v_item);
  end loop;
 end if;

 -- Replays must carry the exact same technician IDs and other write fields.
 -- The inner request hash includes these IDs and the original description
 -- snapshot; renamed or disabled technicians do not rewrite old records.
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
   if v_id not in ('technician_leave','unrecorded_phone_booking')
     or cardinality(v_ids)>0 then raise exception 'FRONTDESK_REQUEST_CONFLICT';end if;
   v_mapped:=v_id;v_payload:=p_body;
  end if;
 else
  -- Check staff approval, OA binding, revocation and fresh session before
  -- any private technician lookup. Only the existing trusted SQL gate decides.
  perform public.platform_frontdesk_request(
   p_tenant_id,p_actor,p_channel_id,p_issued_at,'sync.status','{}'::jsonb
  );
  v_policy:=coalesce(t.module_line#>'{booking,frontdesk,rejectionSettings}',platform_private.frontdesk_rejection_defaults());
  select value into v_reason from jsonb_array_elements(v_policy->'reasons')
   where value->>'id'=v_id and value->>'enabled'='true';
  if v_reason is null then raise exception 'REJECTION_REASON_DISABLED';end if;
  if (v_reason->>'requiresConflictTime')::boolean is distinct from v_paired then
   raise exception 'REJECTION_ROUTE_MISMATCH';end if;
  if not v_paired and (p_body ? 'phoneRequestId' or p_body ? 'startTime' or p_body ? 'totalDurationMinutes') then
   raise exception 'REJECTION_ROUTE_MISMATCH';end if;

  v_description:=v_reason->>'memberDescription';
  if coalesce((v_reason->>'hasVacationTechnicians')::boolean,false) then
   if cardinality(v_ids)<1 then raise exception 'VACATION_TECHNICIANS_REQUIRED';end if;
   v_names:=platform_private.frontdesk_vacation_names(t.runtime_schema,p_body->'vacationTechnicianIds');
   if cardinality(v_names)<>cardinality(v_ids) then
    raise exception 'VACATION_TECHNICIANS_INVALID';end if;
   v_description:=left('目前 '||array_to_string(v_names,'、')||' 技師休假。'
     ||E'\n'||v_description,400);
  elsif p_body ? 'vacationTechnicianIds' then
   raise exception 'VACATION_TECHNICIANS_NOT_ENABLED';
  end if;

  v_mapped:=case when v_paired then 'unrecorded_phone_booking' else 'technician_leave' end;
  v_payload:=p_body||jsonb_build_object(
   'rejectionReason',v_mapped,'rejectionReasonId',v_id,
   'rejectionReasonLabel',v_reason->>'label',
   'rejectionMemberDescription',v_description);
 end if;
 if (v_mapped='unrecorded_phone_booking') is distinct from v_paired then
  raise exception 'REJECTION_ROUTE_MISMATCH';end if;
 return public.platform_frontdesk_request(
  p_tenant_id,p_actor,p_channel_id,p_issued_at,p_action,v_payload
 );
end $rejection$;
revoke all on function public.platform_frontdesk_rejection_request(uuid,text,text,timestamptz,text,jsonb) from public,anon,authenticated;
grant execute on function public.platform_frontdesk_rejection_request(uuid,text,text,timestamptz,text,jsonb) to service_role;
notify pgrst,'reload schema';
