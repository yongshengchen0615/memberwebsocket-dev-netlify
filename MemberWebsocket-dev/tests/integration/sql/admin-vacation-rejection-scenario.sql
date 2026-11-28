-- TEST ONLY. Run as: BEGIN; <this file>; ROLLBACK; on MemberWebsocket-test.
-- A failing assertion aborts the transaction. Never run on production.
do $admin_vacation_scenario$
declare
 t platform_private.tenants;
 v_actor text;v_member uuid;v_service uuid;v_booking uuid;v_stamp text;
 v_primary uuid:=gen_random_uuid();v_selected uuid:=gen_random_uuid();
 v_unrelated uuid:=gen_random_uuid();v_request uuid:=gen_random_uuid();
 v_issued timestamptz;v_body jsonb;v_result jsonb;v_description text;
 v_state text;v_count integer;
begin
 select * into strict t from platform_private.tenants
  where status='active' and features->>'booking'='true'
   and runtime_schema ~ '^business_[0-9a-f]{32}$' limit 1;
 v_actor:=t.owner_line_user_id;
 execute format('select count(*)::int from %I.admins where line_user_id=$1 and status=''active'' and role=''admin''',t.runtime_schema)
  into v_count using v_actor;
 if v_count<>1 then raise exception 'TEST_ADMIN_NOT_AVAILABLE';end if;
 execute format('insert into %I.booking_technicians(id,name,is_active,sort_order) values($1,''合成主要技師'',true,90000),($2,''合成休假技師A'',true,90001),($3,''其他未預約技師'',true,90002)',t.runtime_schema)
  using v_primary,v_selected,v_unrelated;
 execute format('update %I.booking_settings set require_primary_technician=false,primary_technician_id=$1,work_start_time=''08:00'',work_end_time=''22:00'' where id=1',t.runtime_schema)
  using v_primary;
 execute format('insert into %I.booking_service_types(name) values(''VACATION_ADMIN_E2E_20261128'')',t.runtime_schema);
 execute format('insert into %I.members(line_user_id,member_code,invite_code,status,membership_status,is_test_account) values($1,''VACMEM998'',''ABCD123456'',''active'',''active'',true) returning id',t.runtime_schema)
  into v_member using 'Uffffffffffffffffffffffffffffffff';
 execute format('update %I.members set is_test_account=false where id=$1',t.runtime_schema) using v_member;
 execute format('insert into %I.booking_services(title,duration_minutes,price_amount,service_type,created_by) values(''ADMIN_VACATION_TEST'',30,100,''VACATION_ADMIN_E2E_20261128'',$1) returning id',t.runtime_schema)
  into v_service using v_actor;
 execute format('select (%I.create_group_booking_request_v2($1,$2,current_date+3,$3::time,$4,$5)).id',t.runtime_schema)
  into v_booking using 'VAC-ADMIN-'||gen_random_uuid()::text,v_member,'10:00',
   jsonb_build_array(
    jsonb_build_object('technicianId',v_primary,'items',jsonb_build_array(jsonb_build_object('serviceId',v_service,'quantity',1))),
    jsonb_build_object('technicianId',v_selected,'items',jsonb_build_array(jsonb_build_object('serviceId',v_service,'quantity',1)))
   ),'';
 execute format('select updated_at::text from %I.bookings where id=$1',t.runtime_schema) into v_stamp using v_booking;
 v_issued:=clock_timestamp();
 v_body:=jsonb_build_object('bookingId',v_booking,'expectedUpdatedAt',v_stamp,
  'status','rejected','rejectionReason','technician_leave','requestId',v_request,
  'adminNote','合成管理端拒絕','vacationTechnicianIds',jsonb_build_array(v_selected::text));

 -- Foreign / primary technician selection must fail without mutating booking.
 for v_result in select jsonb_build_object('vacationTechnicianIds',jsonb_build_array(x.tech::text))
  from (values(v_primary),(v_unrelated)) x(tech)
 loop
  begin
   perform public.platform_admin_reject_vacation(t.id,v_actor,v_issued,v_body||v_result);
   raise exception 'INVALID_TECH_ACCEPTED';
  exception when raise_exception then
   if sqlerrm<>'VACATION_TECHNICIANS_INVALID' then raise;end if;
  end;
 end loop;
 begin
  perform public.platform_admin_reject_vacation(t.id,'U00000000000000000000000000000000',v_issued,v_body);
  raise exception 'FOREIGN_ADMIN_ACCEPTED';
 exception when raise_exception then
  if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;
 end;
 begin
  perform public.platform_admin_reject_vacation(t.id,v_actor,v_issued,
   jsonb_set(v_body,'{vacationTechnicianIds}','[]'::jsonb));
  raise exception 'EMPTY_VACATION_ACCEPTED';
 exception when raise_exception then
  if sqlerrm<>'VACATION_TECHNICIANS_REQUIRED' then raise;end if;
 end;
 begin
  perform public.platform_admin_reject_vacation(t.id,v_actor,v_issued,
   jsonb_set(v_body,'{vacationTechnicianIds}',jsonb_build_array(v_selected::text,v_selected::text)));
  raise exception 'DUPLICATE_TECH_ACCEPTED';
 exception when raise_exception then
  if sqlerrm<>'VACATION_TECHNICIANS_INVALID' then raise;end if;
 end;
 begin
  perform public.platform_admin_reject_vacation(t.id,v_actor,v_issued,
   jsonb_set(v_body,'{expectedUpdatedAt}',to_jsonb('2026-01-01T00:00:00Z'::text)));
  raise exception 'STALE_BOOKING_ACCEPTED';
 exception when raise_exception then
  if sqlerrm<>'BOOKING_CONFLICT' then raise;end if;
 end;
 execute format('select status from %I.bookings where id=$1',t.runtime_schema)
  into v_state using v_booking;
 if v_state<>'pending' then raise exception 'INVALID_WRITES_MUTATED_BOOKING';end if;

 v_result:=public.platform_admin_reject_vacation(t.id,v_actor,v_issued,v_body);
 if v_result->>'status' is distinct from 'rejected'
   or v_result->>'alreadyApplied' is distinct from 'false'
 then raise exception 'FIRST_REJECTION_INVALID %',v_result;end if;
 execute format('select rejection_member_description from %I.bookings where id=$1',t.runtime_schema)
  into v_description using v_booking;
 if v_description is distinct from '目前預約時間：'||to_char(current_date+3,'YYYY/MM/DD')||' 10:00，合成休假技師A 技師休假。'
 then raise exception 'MEMBER_DESCRIPTION_NOT_CANONICAL %',v_description;end if;

 v_result:=public.platform_admin_reject_vacation(t.id,v_actor,v_issued,v_body);
 if v_result->>'alreadyApplied' is distinct from 'true'
 then raise exception 'REPLAY_NOT_IDEMPOTENT';end if;
 begin
  perform public.platform_admin_reject_vacation(t.id,v_actor,v_issued,
   jsonb_set(v_body,'{vacationTechnicianIds}',jsonb_build_array(v_unrelated::text)));
  raise exception 'ALTERED_REPLAY_ACCEPTED';
 exception when raise_exception then
  if sqlerrm<>'ADMIN_VACATION_REQUEST_CONFLICT' then raise;end if;
 end;
 execute format('select count(*)::int from %I.booking_audit_events where target_id=$1 and actor_role=''admin'' and action=''BOOKING_REJECTED''',t.runtime_schema)
  into v_count using v_booking::text;
 if v_count<>1 then raise exception 'REPLAY_AUDIT_COUNT_INVALID %',v_count;end if;
end $admin_vacation_scenario$;
