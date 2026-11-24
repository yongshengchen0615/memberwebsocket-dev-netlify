-- AC-FMR-001..007: audited modification-vs-new review kind, split frontdesk
-- rejection settings and consistent admin/member LINE titles. Test tenant only.
-- Existing booking status transitions, permission checks, outbox and event keys
-- remain unchanged; reject/confirm still require an approved review staff.
create or replace function platform_private.frontdesk_review_kind(
  p_schema text, p_booking_id uuid, p_status text default 'pending'
) returns text language plpgsql stable security definer set search_path='' as $kind$
declare v_edit bigint := 0;v_review bigint := 0;v_kind text;
begin
  if p_schema !~ '^business_[0-9a-f]{32}$'
     or not exists (select 1 from platform_private.tenants where runtime_schema=p_schema)
    then raise exception 'BUSINESS_SCHEMA_INVALID';end if;
  if p_status='pending' then
    execute format($audit$
      select coalesce(max(e.id) filter (
        where e.actor_role='member' and e.action='BOOKING_UPDATED'),0),
        coalesce(max(e.id) filter (
        where e.action in ('BOOKING_CONFIRMED','BOOKING_REJECTED')),0)
      from %I.booking_audit_events e
      where e.target_type='booking' and e.target_id=$1::text
        and e.result='success'
    $audit$,p_schema) into v_edit,v_review using p_booking_id;
    return case when v_edit>v_review then 'modification' else 'new' end;
  end if;
  if p_status in ('confirmed','rejected') then
    execute format($audit$
      select case when e.actor_role='frontdesk'
        then e.metadata->>'reviewKind' else null end
      from %I.booking_audit_events e
      where e.target_type='booking' and e.target_id=$1::text
        and e.result='success'
        and e.action in ('BOOKING_CONFIRMED','BOOKING_REJECTED')
      order by e.id desc limit 1
    $audit$,p_schema) into v_kind using p_booking_id;
    return case when v_kind='modification' then 'modification' else 'new' end;
  end if;
  return 'new';
end $kind$;
revoke all on function platform_private.frontdesk_review_kind(text,uuid,text) from public,anon,authenticated;
grant execute on function platform_private.frontdesk_review_kind(text,uuid,text) to service_role;

-- The existing reason IDs and saved snapshots are independently scoped per
-- review kind. A saved modification policy must not rewrite the ordinary one.
create or replace function platform_private.frontdesk_rejection_defaults()
returns jsonb language sql immutable set search_path='' as $defaults$
 select jsonb_build_object(
  'dropdownTitle','請選擇拒絕原因',
  'reasons',jsonb_build_array(
   jsonb_build_object('id','technician_leave','label','預約中有休假技師','requiresConflictTime',false,'memberDescription','預約中有休假技師','enabled',true),
   jsonb_build_object('id','unrecorded_phone_booking','label','該時段已被現場人員預約但未登記','requiresConflictTime',true,'memberDescription','該時段已被現場人員預約但未登記','enabled',true)
  ),
  'modification',jsonb_build_object(
   'dropdownTitle','請選擇拒絕修改原因',
   'reasons',jsonb_build_array(
    jsonb_build_object('id','custom_00000000-0000-4000-8000-000000000001',
      'label','修改後時段無法安排','requiresConflictTime',false,
      'memberDescription','修改後的預約時間無法安排，請重新選擇其他時段。',
      'hasVacationTechnicians',false,'enabled',true)
   )
  )
 );
$defaults$;

-- Independent, recursive validation reuses the fully established reason
-- schema while forbidding nested modification sections and forged fields.
do $patch_validator$
declare d text;old_text text;new_text text;
begin
 select pg_get_functiondef('platform_private.validate_frontdesk_rejection_settings(jsonb,jsonb)'::regprocedure) into strict d;
 old_text:='(p_next - ''dropdownTitle'' - ''reasons'') <> ''{}''::jsonb';
 new_text:='(p_next - ''dropdownTitle'' - ''reasons'' - ''modification'') <> ''{}''::jsonb';
 if (length(d)-length(replace(d,old_text,'')))<>length(old_text)
   then raise exception 'FRONTDESK_MODIFICATION_VALIDATOR_INPUT_DRIFT';end if;
 d:=replace(d,old_text,new_text);
 old_text:='v_labels text[]:=array[]::text[];v_enabled integer:=0;';
 new_text:='v_labels text[]:=array[]::text[];v_enabled integer:=0;v_modification jsonb;';
 if (length(d)-length(replace(d,old_text,'')))<>length(old_text)
   then raise exception 'FRONTDESK_MODIFICATION_VALIDATOR_DECLARE_DRIFT';end if;
 d:=replace(d,old_text,new_text);
 old_text:='return jsonb_build_object(''dropdownTitle'',v_title,''reasons'',v_reasons);';
 new_text:=$validation$
 if p_next ? 'modification' then
   if jsonb_typeof(p_next->'modification') is distinct from 'object'
      or (p_next->'modification') ? 'modification'
     then raise exception 'PLATFORM_INVALID_INPUT';end if;
   v_modification:=platform_private.validate_frontdesk_rejection_settings(
     p_next->'modification',null
   ) - 'modification';
 else
   v_modification:=coalesce(
     p_previous->'modification',
     (platform_private.frontdesk_rejection_defaults())->'modification'
   );
 end if;
 return jsonb_build_object(
   'dropdownTitle',v_title,'reasons',v_reasons,'modification',v_modification
 );
$validation$;
 if (length(d)-length(replace(d,old_text,'')))<>length(old_text)
   then raise exception 'FRONTDESK_MODIFICATION_VALIDATOR_RESULT_DRIFT';end if;
 execute replace(d,old_text,new_text);
end $patch_validator$;

-- Preserve existing merchant policy exactly; initialize only the new separate
-- editor and increment the optimistic version so open stale tabs cannot save.
update platform_private.tenants
set module_line=jsonb_set(module_line,
      '{booking,frontdesk,rejectionSettings,modification}',
      (platform_private.frontdesk_rejection_defaults())->'modification',true),
    version=version+1,updated_at=clock_timestamp()
where module_line#>'{booking,frontdesk,rejectionSettings}' is not null
  and module_line#>'{booking,frontdesk,rejectionSettings,modification}' is null
  and runtime_schema ~ '^business_[0-9a-f]{32}$';

do $patch_frontdesk_review$
declare d text;old_text text;new_text text;
begin
 -- Only the authenticated, tenant-scoped projection may calculate kind.
 select pg_get_functiondef('platform_private.frontdesk_booking_json(text,uuid)'::regprocedure) into strict d;
 old_text:='''cancellationPending'',b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null,';
 new_text:=old_text||E'\n   ''reviewKind'',platform_private.frontdesk_review_kind(%1$L,b.id,b.status),';
 if (length(d)-length(replace(d,old_text,'')))<>length(old_text)
   then raise exception 'FRONTDESK_MODIFICATION_BOOKING_PROJECTION_DRIFT';end if;
 execute replace(d,old_text,new_text);

 select pg_get_functiondef('public.platform_frontdesk_request(uuid,text,text,timestamptz,text,jsonb)'::regprocedure) into strict d;
 old_text:='notice_message text;store_service_minutes integer;';
 new_text:='notice_message text;v_review_kind text;store_service_minutes integer;';
 if (length(d)-length(replace(d,old_text,'')))<>length(old_text)
   then raise exception 'FRONTDESK_MODIFICATION_REVIEW_DECLARE_DRIFT';end if;
 d:=replace(d,old_text,new_text);

 old_text:='  execute format(''update %I.bookings set status=$2,admin_note=';
 new_text:='  v_review_kind:=platform_private.frontdesk_review_kind(t.runtime_schema,bid,''pending'');'||E'\n'||old_text;
 if (length(d)-length(replace(d,old_text,'')))<>length(old_text)
   then raise exception 'FRONTDESK_MODIFICATION_REVIEW_SNAPSHOT_DRIFT';end if;
 d:=replace(d,old_text,new_text);

 old_text:='jsonb_build_object(''previousStatus'',''pending'',''rejectionReason'',';
 new_text:='jsonb_build_object(''previousStatus'',''pending'',''reviewKind'',v_review_kind,''rejectionReason'',';
 if (length(d)-length(replace(d,old_text,'')))<>length(old_text)
   then raise exception 'FRONTDESK_MODIFICATION_REVIEW_AUDIT_DRIFT';end if;
 d:=replace(d,old_text,new_text);

 old_text:='notice_message:=''【櫃檯確認預約】''';
 new_text:='notice_message:=(case when v_review_kind=''modification'' then ''【櫃檯確認修改】'' else ''【櫃檯確認預約】'' end)';
 if (length(d)-length(replace(d,old_text,'')))<>length(old_text)
   then raise exception 'FRONTDESK_MODIFICATION_CONFIRM_LINE_DRIFT';end if;
 execute replace(d,old_text,new_text);

 -- Rejection is validated and selected by server-side pending modification
 -- evidence, never by a client-supplied isModification flag or reason bucket.
 select pg_get_functiondef('public.platform_frontdesk_rejection_request(uuid,text,text,timestamptz,text,jsonb)'::regprocedure) into strict d;
 old_text:='jsonb_array_elements(v_policy->''reasons'')';
 new_text:=$bucket$jsonb_array_elements(
     case when platform_private.frontdesk_review_kind(
       t.runtime_schema,(p_body->>'bookingId')::uuid,'pending'
     )='modification'
     then coalesce(
       v_policy->'modification'->'reasons',
       (platform_private.frontdesk_rejection_defaults())->'modification'->'reasons')
     else v_policy->'reasons' end
   )$bucket$;
 if (length(d)-length(replace(d,old_text,'')))<>length(old_text)
   then raise exception 'FRONTDESK_MODIFICATION_REJECTION_ROUTE_DRIFT';end if;
 execute replace(d,old_text,new_text);

 -- The detailed admin-only rejection notification keeps the original and
 -- any separately verified phone booking's participant data intact.
 select pg_get_functiondef('platform_private.append_booking_rejection_notice()'::regprocedure) into strict d;
 old_text:='v_admin_message:=''【櫃檯拒絕預約】''';
 new_text:='v_admin_message:=(case when platform_private.frontdesk_review_kind(v_schema,NEW.id,''rejected'')=''modification'' then ''【櫃檯拒絕修改】'' else ''【櫃檯拒絕預約】'' end)';
 if (length(d)-length(replace(d,old_text,'')))<>length(old_text)
   then raise exception 'FRONTDESK_MODIFICATION_REJECTION_ADMIN_DRIFT';end if;
 execute replace(d,old_text,new_text);
end $patch_frontdesk_review$;

-- Member notice is produced by the existing deferred, audited status trigger.
-- Patch both existing tenant functions and the future-merchant template.
do $patch_modification_member_line$
declare d text;source text;snapshot jsonb;item jsonb;functions jsonb:='[]'::jsonb;
 t record;changed integer:=0;old_confirm text;new_confirm text;old_reject text;new_reject text;
begin
 old_confirm:='when ''confirmed'' then ''【預約確認】''';
 new_confirm:='when ''confirmed'' then case when platform_private.frontdesk_review_kind(TG_TABLE_SCHEMA,NEW.id,''confirmed'')=''modification'' then ''【確認修改預約】'' else ''【預約確認】'' end';
 old_reject:='when ''rejected'' then ''【預約未通過】''';
 new_reject:='when ''rejected'' then case when platform_private.frontdesk_review_kind(TG_TABLE_SCHEMA,NEW.id,''rejected'')=''modification'' then ''【拒絕修改預約】'' else ''【預約未通過】'' end';

 select snapshot into strict snapshot from platform_private.business_templates
  where version='business-v1-20261019' for update;
 for item in select value from jsonb_array_elements(snapshot->'functions') loop
  if item->>'name'='notice_enqueue' then
   d:=item->>'definition';
   if (length(d)-length(replace(d,old_confirm,'')))<>length(old_confirm)
      or (length(d)-length(replace(d,old_reject,'')))<>length(old_reject)
     then raise exception 'FRONTDESK_MODIFICATION_TEMPLATE_NOTICE_DRIFT';end if;
   d:=replace(replace(d,old_confirm,new_confirm),old_reject,new_reject);
   item:=jsonb_set(item,'{definition}',to_jsonb(d));
   changed:=changed+1;
  end if;
  functions:=functions||jsonb_build_array(item);
 end loop;
 if changed<>1 then raise exception 'FRONTDESK_MODIFICATION_TEMPLATE_NOTICE_MISSING';end if;
 update platform_private.business_templates set snapshot=jsonb_set(snapshot,'{functions}',functions)
 where version='business-v1-20261019';

 for t in select runtime_schema from platform_private.tenants
   where runtime_schema ~ '^business_[0-9a-f]{32}$' loop
  select pg_get_functiondef(to_regprocedure(format('%I.notice_enqueue()',t.runtime_schema)))
    into strict source;
  if (length(source)-length(replace(source,old_confirm,'')))<>length(old_confirm)
     or (length(source)-length(replace(source,old_reject,'')))<>length(old_reject)
    then raise exception 'FRONTDESK_MODIFICATION_TENANT_NOTICE_DRIFT: %',t.runtime_schema;end if;
  execute replace(replace(source,old_confirm,new_confirm),old_reject,new_reject);
 end loop;
end $patch_modification_member_line$;
