-- TEST ONLY: run inside BEGIN + new migration + this fixture + ROLLBACK.
-- Never run this scenario against production; creates synthetic staff, a member,
-- a booking, and triggers rejection notifications, all inside a rollback.
do $vacation_e2e$
declare t platform_private.tenants;ch text;mid uuid;sid uuid;bid uuid;stamp text;
 rid uuid:=gen_random_uuid();body jsonb;result jsonb;description text;audit_count int;
 actor text:='Ueeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
 tech_p uuid:='22222222-2222-4222-8222-222222222292';
 tech_a uuid:='11111111-1111-4111-8111-111111111191';
 tech_c uuid:='33333333-3333-4333-8333-333333333393';
 issued timestamptz;
begin
 select * into strict t from platform_private.tenants
  where module_line#>>'{booking,frontdesk,enabled}'='true' limit 1;
 ch:=t.module_line#>>'{booking,frontdesk,loginChannelId}';
 execute format('insert into %I.booking_technicians(id,name,is_active,sort_order) values($1,''合成主要技師'',true,90000),($2,''合成A'',true,90001),($3,''未被預約C'',true,90002)',t.runtime_schema)
 using tech_p,tech_a,tech_c;
 insert into platform_private.frontdesk_staff(tenant_id,login_channel_id,line_user_id,display_name,status,permission_mode,oa_verified_at)
 values(t.id,ch,actor,'合成櫃檯','approved','review',clock_timestamp());
 update platform_private.tenants set module_line=jsonb_set(module_line,'{booking,frontdesk,rejectionSettings}',
  jsonb_set(platform_private.frontdesk_rejection_defaults(),'{reasons,0,hasVacationTechnicians}','true'::jsonb,true),true)
 where id=t.id;
 execute format('update %I.booking_settings set require_primary_technician=false,primary_technician_id=$1,work_start_time=''08:00'',work_end_time=''22:00'' where id=1',t.runtime_schema) using tech_p;
 execute format('insert into %I.booking_service_types(name) values(''VACATION_E2E_20261124'')',t.runtime_schema);
 execute format('insert into %I.members(line_user_id,member_code,invite_code,status,membership_status,is_test_account) values($1,''VACMEM123'',''ABCD123456'',''active'',''active'',true) returning id',t.runtime_schema)
 into mid using 'Udddddddddddddddddddddddddddddddd';
 execute format('update %I.members set is_test_account=false where id=$1',t.runtime_schema) using mid;
 execute format('insert into %I.booking_services(title,duration_minutes,price_amount,service_type,created_by) values(''VAC_TEST'',30,100,''VACATION_E2E_20261124'',$1) returning id',t.runtime_schema)
 into sid using actor;
 execute format('select (%I.create_group_booking_request_v2($1,$2,current_date+3,$3::time,$4,$5)).id',t.runtime_schema)
 into bid using 'VAC-'||gen_random_uuid()::text,mid,'10:00',
  jsonb_build_array(
   jsonb_build_object('technicianId',tech_p,'items',jsonb_build_array(jsonb_build_object('serviceId',sid,'quantity',1))),
   jsonb_build_object('technicianId',tech_a,'items',jsonb_build_array(jsonb_build_object('serviceId',sid,'quantity',1)))
  ),'';
 execute format('select updated_at::text from %I.bookings where id=$1',t.runtime_schema) into stamp using bid;
 -- Only the recorded non-primary participant is offered; unrelated
 -- merchant technicians and the store's primary technician are excluded.
 if not exists(select 1 from jsonb_array_elements(platform_private.frontdesk_booked_vacation_candidates(t.runtime_schema,bid)) row
   where row->>'id'=tech_a::text and row->>'name'='合成A') then
   raise exception 'BOOKED_SECONDARY_NOT_LISTED';end if;
 if exists(select 1 from jsonb_array_elements(platform_private.frontdesk_booked_vacation_candidates(t.runtime_schema,bid)) row
   where row->>'id' in (tech_p::text,tech_c::text)) then
   raise exception 'PRIMARY_OR_UNBOOKED_LISTED';end if;
 execute format('update %I.booking_technicians set is_active=false where id=$1',t.runtime_schema) using tech_a;
 if not exists(select 1 from jsonb_array_elements(platform_private.frontdesk_booked_vacation_candidates(t.runtime_schema,bid)) row
   where row->>'id'=tech_a::text) then raise exception 'BOOKED_INACTIVE_REMOVED';end if;
 issued:=clock_timestamp();
 body:=jsonb_build_object('bookingId',bid,'expectedUpdatedAt',stamp,
  'status','rejected','rejectionReason','technician_leave','requestId',rid,
  'vacationTechnicianIds',jsonb_build_array(tech_a::text));
 for result in select jsonb_build_object('vacationTechnicianIds',jsonb_build_array(x.id::text))
  from (values(tech_p),(tech_c)) x(id) loop
   begin
    perform public.platform_frontdesk_rejection_request(t.id,actor,ch,issued,'booking.update',body||result);
    raise exception 'UNBOOKED_TECHNICIAN_ACCEPTED';
   exception when raise_exception then
    if sqlerrm<>'VACATION_TECHNICIANS_INVALID' then raise;end if;
   end;
 end loop;
 result:=public.platform_frontdesk_rejection_request(t.id,actor,ch,issued,'booking.update',body);
 description:=result#>>'{booking,rejectionMemberDescription}';
 if description is distinct from '目前 合成A 技師休假。'||E'\n'||'預約中有休假技師'
   or result#>>'{booking,status}' is distinct from 'rejected' then
   raise exception 'VACATION_BOOKING_SNAPSHOT_INVALID %',result;end if;
 result:=public.platform_frontdesk_rejection_request(t.id,actor,ch,issued,'booking.update',body);
 if result->>'alreadyApplied' is distinct from 'true'
   or result#>>'{booking,rejectionMemberDescription}' is distinct from description then
   raise exception 'VACATION_REPLAY_CHANGED';end if;
 begin
  perform public.platform_frontdesk_rejection_request(t.id,actor,ch,issued,'booking.update',
    jsonb_set(body,'{vacationTechnicianIds}',jsonb_build_array(tech_c::text)));
  raise exception 'VACATION_REPLAY_TAMPER_ACCEPTED';
 exception when raise_exception then
  if sqlerrm<>'FRONTDESK_REQUEST_CONFLICT' then raise;end if;
 end;
 execute format('select count(*)::int from %I.booking_audit_events where target_id=$1 and action=''BOOKING_REJECTED''',t.runtime_schema)
 into audit_count using bid::text;
 if audit_count<>1 then raise exception 'VACATION_AUDIT_DUPLICATE %',audit_count;end if;
end $vacation_e2e$;

-- Flush the deferred booking notification trigger inside the rollback-only
-- transaction. Assert the actual generated admin LINE outbox, not just source.
set constraints all immediate;
do $line_outbox$
declare t platform_private.tenants;v_recipients int;v_events int;v_text text;
begin
 select * into strict t from platform_private.tenants
  where module_line#>>'{booking,frontdesk,enabled}'='true' limit 1;
 execute format($check$
  select count(*)::int,count(distinct event_key)::int,max(message_text)
  from %I.notice_outbox
  where channel='admin' and message_text like '【櫃檯拒絕預約】%%'
   and message_text like '%%合成主要技師%%' and message_text like '%%合成A%%'
 $check$,t.runtime_schema) into v_recipients,v_events,v_text;
 if v_recipients<1 or v_events<>1 then
  raise exception 'ADMIN_LINE_OUTBOX_INCONSISTENT recipients=% events=%',v_recipients,v_events;end if;
 if position('【個別預約資料】' in v_text)=0
   or position('第1位預約' in v_text)=0
   or position('第2位預約' in v_text)=0
 then raise exception 'LINE_MISSING_PARTICIPANT_SECTIONS';end if;
 if v_text like '%很抱歉，本次預約未通過。請依拒絕原因%' then
  raise exception 'RETIRED_REJECTION_TEMPLATE_LEAKED';end if;
end $line_outbox$;
