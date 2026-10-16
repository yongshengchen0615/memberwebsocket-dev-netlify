-- Run against an isolated or live database; every fixture is rolled back.
begin;
do $test$
declare
  v_member uuid;
  v_booking uuid;
  v_overnight uuid;
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_due timestamptz;
  v_id uuid;
  v_skip boolean;
  v_status text;
  v_recipient text := 'U00000000000000000000000000000000';
begin
  update public.booking_settings set reminder_enabled = true, reminder_time = time '00:00',
    min_advance_days = 0, work_start_time = time '14:00', work_end_time = time '02:00'
    where id = 1;
  -- The fixture needs valid booking dates even if an admin marked tomorrow as a holiday.
  update public.calendar_items set status = 'draft'
    where item_type = 'holiday' and status = 'active'
      and starts_on <= v_today + 2 and coalesce(ends_on,starts_on) >= v_today;
  insert into public.members(line_user_id, member_code, display_name, is_test_account)
    values (v_recipient, 'REMINDER-QA-' || substr(gen_random_uuid()::text,1,8), 'QA', false)
    returning id into v_member;
  insert into public.bookings(request_id,service_id,member_id,booking_date,start_time,end_time,
                              status,total_duration_minutes,technician_id)
    values ('reminder-qa-' || gen_random_uuid()::text,
      '00000000-0000-4000-8000-000000000010',v_member,v_today + 1,
      time '14:00',time '14:30','confirmed',30,
      (select id from public.booking_technicians limit 1))
    returning id into v_booking;
  insert into public.bookings(request_id,service_id,member_id,booking_date,start_time,end_time,
                              starts_next_day,status,total_duration_minutes,technician_id)
    values ('reminder-qa-' || gen_random_uuid()::text,
      '00000000-0000-4000-8000-000000000010',v_member,v_today,
      time '00:30',time '01:00',true,'confirmed',30,
      (select id from public.booking_technicians limit 1))
    returning id into v_overnight;
  perform booking_notifications.sync_day_before_reminders();
  if (select count(*) from booking_notifications.outbox
      where booking_id in (v_booking,v_overnight) and event_key ~ ':reminder:day_before$') <> 2
  then raise exception 'EXPECTED_TWO_REMINDERS'; end if;
  select id,next_attempt_at into v_id,v_due from booking_notifications.outbox
    where booking_id = v_overnight and event_key ~ ':reminder:day_before$';
  if v_due <> (v_today + time '00:00') at time zone 'Asia/Taipei'
  then raise exception 'OVERNIGHT_DATE_IS_WRONG'; end if;
  perform booking_notifications.sync_day_before_reminders();
  if (select count(*) from booking_notifications.outbox
      where booking_id = v_overnight and event_key ~ ':reminder:day_before$') <> 1
  then raise exception 'DUPLICATE_REMINDER'; end if;
  update public.bookings set booking_date = v_today + 2
    where id = v_booking;
  perform booking_notifications.sync_day_before_reminders();
  if (select reminder_start_at from booking_notifications.outbox
      where booking_id = v_booking and event_key ~ ':reminder:day_before$')
     <> (v_today + 2) + time '14:00'
  then raise exception 'RESCHEDULE_DID_NOT_RECALCULATE'; end if;
  update public.bookings set cancellation_requested_at = now(),
    cancellation_requested_by = 'member', cancellation_source_status = 'confirmed'
    where id = v_overnight;
  update booking_notifications.outbox set status='sending',attempt_count=1
    where id = v_id;
  v_skip := public.skip_invalid_booking_reminder(v_id,1);
  select status into v_status from booking_notifications.outbox where id=v_id;
  if v_skip is distinct from true or v_status <> 'skipped'
  then raise exception 'CANCELLATION_REQUEST_REMINDER_WAS_NOT_SKIPPED: %, %', v_skip, v_status; end if;
end $test$;
rollback;
