-- AC-001..AC-009: booking-level opt-in and preceding-day delivery in Asia/Taipei.
-- Keep retired global settings columns/functions for compatibility; they no longer govern dispatch.
alter table public.bookings
  add column reminder_enabled boolean not null default false,
  add column reminder_time time without time zone not null default time '18:00';
alter table public.bookings
  add constraint bookings_reminder_minute_check
  check (extract(second from reminder_time) = 0);

-- Existing confirmed future reservations inherit the previously configured business policy.
-- Newly created bookings always default to opt-out unless member opts in.
update public.bookings b
   set reminder_enabled = s.reminder_enabled,
       reminder_time = s.reminder_time
  from public.booking_settings s
 where s.id = 1
   and b.status = 'confirmed'
   and b.start_at::date > (now() at time zone 'Asia/Taipei')::date;


create or replace function public.create_booking_bundle_with_benefits_reminder(
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time,
  p_items jsonb,
  p_member_note text,
  p_benefits jsonb,
  p_reminder_enabled boolean,
  p_reminder_time time
) returns public.bookings
language plpgsql security definer set search_path = '' as $reminder_wrapper$
declare
  v_booking public.bookings;
  v_prior_id uuid;
  v_prior_enabled boolean;
  v_prior_time time;
  v_existed boolean := false;
begin
  if p_reminder_enabled is null or p_reminder_time is null
     or extract(second from p_reminder_time) <> 0 then
    raise exception 'INVALID_BOOKING_REMINDER';
  end if;
  
  -- Serialize retries using the same request key; a retry cannot change consent.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id, 60031));
  select b.id, b.reminder_enabled, b.reminder_time
    into v_prior_id, v_prior_enabled, v_prior_time
    from public.bookings b where b.request_id = p_request_id;
  v_existed := found;

  v_booking := public.create_booking_bundle_with_benefits_request(p_request_id, p_member_id, p_booking_date, p_start_time, p_items, p_member_note, p_benefits);
  
  if v_existed then
    if v_booking.id is distinct from v_prior_id
      or v_prior_enabled is distinct from p_reminder_enabled
      or v_prior_time is distinct from p_reminder_time then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return v_booking;
  end if;

  if p_reminder_enabled and (
      v_booking.start_at is null
      or (((v_booking.start_at::date - 1) + p_reminder_time)
          at time zone 'Asia/Taipei') <= pg_catalog.clock_timestamp()
  ) then
    raise exception 'REMINDER_TIME_PASSED';
  end if;
  update public.bookings b
     set reminder_enabled = p_reminder_enabled,
         reminder_time = p_reminder_time
   where b.id = v_booking.id
     and b.member_id = p_member_id
  returning b.* into v_booking;
  if not found then raise exception 'BOOKING_REMINDER_OWNER_MISMATCH'; end if;
  return v_booking;
end $reminder_wrapper$;
revoke all on function public.create_booking_bundle_with_benefits_reminder(text, uuid, date, time, jsonb, text, jsonb, boolean, time) from public, anon, authenticated;
grant execute on function public.create_booking_bundle_with_benefits_reminder(text, uuid, date, time, jsonb, text, jsonb, boolean, time) to service_role;


create or replace function public.update_booking_bundle_with_benefits_reminder(
  p_booking_id uuid,
  p_expected_updated_at timestamptz,
  p_actor text,
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time,
  p_items jsonb,
  p_member_note text,
  p_benefits jsonb,
  p_reminder_enabled boolean,
  p_reminder_time time
) returns public.bookings
language plpgsql security definer set search_path = '' as $reminder_wrapper$
declare
  v_booking public.bookings;
  
begin
  if p_reminder_enabled is null or p_reminder_time is null
     or extract(second from p_reminder_time) <> 0 then
    raise exception 'INVALID_BOOKING_REMINDER';
  end if;
  
  v_booking := public.update_booking_bundle_with_benefits_request(p_booking_id, p_expected_updated_at, p_actor, p_request_id, p_member_id, p_booking_date, p_start_time, p_items, p_member_note, p_benefits);
  
  if p_reminder_enabled and (
      v_booking.start_at is null
      or (((v_booking.start_at::date - 1) + p_reminder_time)
          at time zone 'Asia/Taipei') <= pg_catalog.clock_timestamp()
  ) then
    raise exception 'REMINDER_TIME_PASSED';
  end if;
  update public.bookings b
     set reminder_enabled = p_reminder_enabled,
         reminder_time = p_reminder_time
   where b.id = v_booking.id
     and b.member_id = p_member_id
  returning b.* into v_booking;
  if not found then raise exception 'BOOKING_REMINDER_OWNER_MISMATCH'; end if;
  return v_booking;
end $reminder_wrapper$;
revoke all on function public.update_booking_bundle_with_benefits_reminder(uuid, timestamptz, text, text, uuid, date, time, jsonb, text, jsonb, boolean, time) from public, anon, authenticated;
grant execute on function public.update_booking_bundle_with_benefits_reminder(uuid, timestamptz, text, text, uuid, date, time, jsonb, text, jsonb, boolean, time) to service_role;


create or replace function public.create_booking_bundle_with_contact_reminder(
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time,
  p_items jsonb,
  p_member_note text,
  p_contact_source text,
  p_contact_surname text,
  p_contact_salutation text,
  p_contact_phone text,
  p_reminder_enabled boolean,
  p_reminder_time time
) returns public.bookings
language plpgsql security definer set search_path = '' as $reminder_wrapper$
declare
  v_booking public.bookings;
  v_prior_id uuid;
  v_prior_enabled boolean;
  v_prior_time time;
  v_existed boolean := false;
begin
  if p_reminder_enabled is null or p_reminder_time is null
     or extract(second from p_reminder_time) <> 0 then
    raise exception 'INVALID_BOOKING_REMINDER';
  end if;
  
  -- Serialize retries using the same request key; a retry cannot change consent.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id, 60031));
  select b.id, b.reminder_enabled, b.reminder_time
    into v_prior_id, v_prior_enabled, v_prior_time
    from public.bookings b where b.request_id = p_request_id;
  v_existed := found;

  v_booking := public.create_booking_bundle_with_contact(p_request_id, p_member_id, p_booking_date, p_start_time, p_items, p_member_note, p_contact_source, p_contact_surname, p_contact_salutation, p_contact_phone);
  
  if v_existed then
    if v_booking.id is distinct from v_prior_id
      or v_prior_enabled is distinct from p_reminder_enabled
      or v_prior_time is distinct from p_reminder_time then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return v_booking;
  end if;

  if p_reminder_enabled and (
      v_booking.start_at is null
      or (((v_booking.start_at::date - 1) + p_reminder_time)
          at time zone 'Asia/Taipei') <= pg_catalog.clock_timestamp()
  ) then
    raise exception 'REMINDER_TIME_PASSED';
  end if;
  update public.bookings b
     set reminder_enabled = p_reminder_enabled,
         reminder_time = p_reminder_time
   where b.id = v_booking.id
     and b.member_id = p_member_id
  returning b.* into v_booking;
  if not found then raise exception 'BOOKING_REMINDER_OWNER_MISMATCH'; end if;
  return v_booking;
end $reminder_wrapper$;
revoke all on function public.create_booking_bundle_with_contact_reminder(text, uuid, date, time, jsonb, text, text, text, text, text, boolean, time) from public, anon, authenticated;
grant execute on function public.create_booking_bundle_with_contact_reminder(text, uuid, date, time, jsonb, text, text, text, text, text, boolean, time) to service_role;


create or replace function public.update_booking_bundle_with_contact_reminder(
  p_booking_id uuid,
  p_expected_updated_at timestamptz,
  p_actor text,
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time,
  p_items jsonb,
  p_member_note text,
  p_contact_source text,
  p_contact_surname text,
  p_contact_salutation text,
  p_contact_phone text,
  p_reminder_enabled boolean,
  p_reminder_time time
) returns public.bookings
language plpgsql security definer set search_path = '' as $reminder_wrapper$
declare
  v_booking public.bookings;
  
begin
  if p_reminder_enabled is null or p_reminder_time is null
     or extract(second from p_reminder_time) <> 0 then
    raise exception 'INVALID_BOOKING_REMINDER';
  end if;
  
  v_booking := public.update_booking_bundle_with_contact(p_booking_id, p_expected_updated_at, p_actor, p_request_id, p_member_id, p_booking_date, p_start_time, p_items, p_member_note, p_contact_source, p_contact_surname, p_contact_salutation, p_contact_phone);
  
  if p_reminder_enabled and (
      v_booking.start_at is null
      or (((v_booking.start_at::date - 1) + p_reminder_time)
          at time zone 'Asia/Taipei') <= pg_catalog.clock_timestamp()
  ) then
    raise exception 'REMINDER_TIME_PASSED';
  end if;
  update public.bookings b
     set reminder_enabled = p_reminder_enabled,
         reminder_time = p_reminder_time
   where b.id = v_booking.id
     and b.member_id = p_member_id
  returning b.* into v_booking;
  if not found then raise exception 'BOOKING_REMINDER_OWNER_MISMATCH'; end if;
  return v_booking;
end $reminder_wrapper$;
revoke all on function public.update_booking_bundle_with_contact_reminder(uuid, timestamptz, text, text, uuid, date, time, jsonb, text, text, text, text, text, boolean, time) from public, anon, authenticated;
grant execute on function public.update_booking_bundle_with_contact_reminder(uuid, timestamptz, text, text, uuid, date, time, jsonb, text, text, text, text, text, boolean, time) to service_role;


create or replace function public.create_group_booking_with_benefits_reminder_v2(
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time,
  p_participants jsonb,
  p_member_note text,
  p_contact_source text,
  p_contact_surname text,
  p_contact_salutation text,
  p_contact_phone text,
  p_benefits jsonb,
  p_reminder_enabled boolean,
  p_reminder_time time
) returns public.bookings
language plpgsql security definer set search_path = '' as $reminder_wrapper$
declare
  v_booking public.bookings;
  v_prior_id uuid;
  v_prior_enabled boolean;
  v_prior_time time;
  v_existed boolean := false;
begin
  if p_reminder_enabled is null or p_reminder_time is null
     or extract(second from p_reminder_time) <> 0 then
    raise exception 'INVALID_BOOKING_REMINDER';
  end if;
  
  -- Serialize retries using the same request key; a retry cannot change consent.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id, 60031));
  select b.id, b.reminder_enabled, b.reminder_time
    into v_prior_id, v_prior_enabled, v_prior_time
    from public.bookings b where b.request_id = p_request_id;
  v_existed := found;

  v_booking := public.create_group_booking_with_benefits_request_v2(p_request_id, p_member_id, p_booking_date, p_start_time, p_participants, p_member_note, p_contact_source, p_contact_surname, p_contact_salutation, p_contact_phone, p_benefits);
  
  if v_existed then
    if v_booking.id is distinct from v_prior_id
      or v_prior_enabled is distinct from p_reminder_enabled
      or v_prior_time is distinct from p_reminder_time then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return v_booking;
  end if;

  if p_reminder_enabled and (
      v_booking.start_at is null
      or (((v_booking.start_at::date - 1) + p_reminder_time)
          at time zone 'Asia/Taipei') <= pg_catalog.clock_timestamp()
  ) then
    raise exception 'REMINDER_TIME_PASSED';
  end if;
  update public.bookings b
     set reminder_enabled = p_reminder_enabled,
         reminder_time = p_reminder_time
   where b.id = v_booking.id
     and b.member_id = p_member_id
  returning b.* into v_booking;
  if not found then raise exception 'BOOKING_REMINDER_OWNER_MISMATCH'; end if;
  return v_booking;
end $reminder_wrapper$;
revoke all on function public.create_group_booking_with_benefits_reminder_v2(text, uuid, date, time, jsonb, text, text, text, text, text, jsonb, boolean, time) from public, anon, authenticated;
grant execute on function public.create_group_booking_with_benefits_reminder_v2(text, uuid, date, time, jsonb, text, text, text, text, text, jsonb, boolean, time) to service_role;


create or replace function public.update_group_booking_with_benefits_reminder_v2(
  p_booking_id uuid,
  p_expected_updated_at timestamptz,
  p_actor text,
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time,
  p_participants jsonb,
  p_member_note text,
  p_contact_source text,
  p_contact_surname text,
  p_contact_salutation text,
  p_contact_phone text,
  p_benefits jsonb,
  p_reminder_enabled boolean,
  p_reminder_time time
) returns public.bookings
language plpgsql security definer set search_path = '' as $reminder_wrapper$
declare
  v_booking public.bookings;
  
begin
  if p_reminder_enabled is null or p_reminder_time is null
     or extract(second from p_reminder_time) <> 0 then
    raise exception 'INVALID_BOOKING_REMINDER';
  end if;
  
  v_booking := public.update_group_booking_with_benefits_request_v2(p_booking_id, p_expected_updated_at, p_actor, p_request_id, p_member_id, p_booking_date, p_start_time, p_participants, p_member_note, p_contact_source, p_contact_surname, p_contact_salutation, p_contact_phone, p_benefits);
  
  if p_reminder_enabled and (
      v_booking.start_at is null
      or (((v_booking.start_at::date - 1) + p_reminder_time)
          at time zone 'Asia/Taipei') <= pg_catalog.clock_timestamp()
  ) then
    raise exception 'REMINDER_TIME_PASSED';
  end if;
  update public.bookings b
     set reminder_enabled = p_reminder_enabled,
         reminder_time = p_reminder_time
   where b.id = v_booking.id
     and b.member_id = p_member_id
  returning b.* into v_booking;
  if not found then raise exception 'BOOKING_REMINDER_OWNER_MISMATCH'; end if;
  return v_booking;
end $reminder_wrapper$;
revoke all on function public.update_group_booking_with_benefits_reminder_v2(uuid, timestamptz, text, text, uuid, date, time, jsonb, text, text, text, text, text, jsonb, boolean, time) from public, anon, authenticated;
grant execute on function public.update_group_booking_with_benefits_reminder_v2(uuid, timestamptz, text, text, uuid, date, time, jsonb, text, text, text, text, text, jsonb, boolean, time) to service_role;


create or replace function public.create_friend_booking_with_reminder(
  p_actor text,
  p_friend_code text,
  p_request_id text,
  p_booking_date date,
  p_start_time time,
  p_participants jsonb,
  p_member_note text,
  p_contact_source text,
  p_contact_surname text,
  p_contact_salutation text,
  p_contact_phone text,
  p_benefits jsonb,
  p_reminder_enabled boolean,
  p_reminder_time time
) returns public.bookings
language plpgsql security definer set search_path = '' as $reminder_wrapper$
declare
  v_booking public.bookings;
  v_prior_id uuid;
  v_prior_enabled boolean;
  v_prior_time time;
  v_existed boolean := false;
begin
  if p_reminder_enabled is null or p_reminder_time is null
     or extract(second from p_reminder_time) <> 0 then
    raise exception 'INVALID_BOOKING_REMINDER';
  end if;
  
  -- Serialize retries using the same request key; a retry cannot change consent.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id, 60031));
  select b.id, b.reminder_enabled, b.reminder_time
    into v_prior_id, v_prior_enabled, v_prior_time
    from public.bookings b where b.request_id = p_request_id;
  v_existed := found;

  v_booking := public.create_friend_booking_request(p_actor, p_friend_code, p_request_id, p_booking_date, p_start_time, p_participants, p_member_note, p_contact_source, p_contact_surname, p_contact_salutation, p_contact_phone, p_benefits);
  
  if v_existed then
    if v_booking.id is distinct from v_prior_id
      or v_prior_enabled is distinct from p_reminder_enabled
      or v_prior_time is distinct from p_reminder_time then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return v_booking;
  end if;

  if p_reminder_enabled and (
      v_booking.start_at is null
      or (((v_booking.start_at::date - 1) + p_reminder_time)
          at time zone 'Asia/Taipei') <= pg_catalog.clock_timestamp()
  ) then
    raise exception 'REMINDER_TIME_PASSED';
  end if;
  update public.bookings b
     set reminder_enabled = p_reminder_enabled,
         reminder_time = p_reminder_time
   where b.id = v_booking.id
     
  returning b.* into v_booking;
  if not found then raise exception 'BOOKING_REMINDER_OWNER_MISMATCH'; end if;
  return v_booking;
end $reminder_wrapper$;
revoke all on function public.create_friend_booking_with_reminder(text, text, text, date, time, jsonb, text, text, text, text, text, jsonb, boolean, time) from public, anon, authenticated;
grant execute on function public.create_friend_booking_with_reminder(text, text, text, date, time, jsonb, text, text, text, text, text, jsonb, boolean, time) to service_role;


create or replace function booking_notifications.sync_day_before_reminders()
returns integer language plpgsql security definer set search_path = '' as $reminder_sync$
declare
  v_count integer := 0;
  v_today date := (now() at time zone 'Asia/Taipei')::date;
begin
  if not pg_try_advisory_xact_lock(738491205315::bigint) then return 0; end if;

  -- An unattempted reminder that is opted out or no longer eligible must not be sent.
  update booking_notifications.outbox q
     set status = 'skipped', last_error = 'Reminder disabled or booking no longer eligible'
    from public.bookings b
   where q.booking_id = b.id
     and q.event_key ~ ':reminder:day_before$'
     and q.status = 'pending' and q.attempt_count = 0
     and q.first_attempt_at is null
     and (not b.reminder_enabled or b.status <> 'confirmed'
          or b.cancellation_requested_at is not null);

  -- Keep pending reminders aligned with the actual appointment and member-selected time.
  update booking_notifications.outbox q
     set reminder_start_at = b.start_at,
         recipient = m.line_user_id,
         message_text = left('【預約提醒】' || E'\n日期：' ||
           to_char(b.start_at, 'YYYY/MM/DD') || E'\n時段：' ||
           to_char(b.start_at, 'HH24:MI') || '（台北時間）' ||
           E'\n請準時到場；如需調整請至預約頁操作。', 2200),
         next_attempt_at = ((b.start_at::date - 1) + b.reminder_time) at time zone 'Asia/Taipei',
         last_error = null
    from public.bookings b join public.members m on m.id = b.member_id
   where q.booking_id = b.id and q.event_key ~ ':reminder:day_before$'
     and q.status = 'pending' and q.attempt_count = 0 and q.first_attempt_at is null
     and b.reminder_enabled and b.status = 'confirmed' and b.cancellation_requested_at is null
     and b.start_at::date > v_today
     and m.is_test_account is not true and m.line_user_id ~ '^U[0-9a-f]{32}$'
     and (q.reminder_start_at is distinct from b.start_at
          or q.recipient is distinct from m.line_user_id
          or q.next_attempt_at is distinct from
             (((b.start_at::date - 1) + b.reminder_time) at time zone 'Asia/Taipei'));

  if not coalesce((select enabled from booking_notifications.config where id), false)
    then return 0;
  end if;

  insert into booking_notifications.outbox
    (booking_id, event_key, channel, recipient, message_text, reminder_start_at, next_attempt_at)
  select b.id, b.id::text || ':reminder:day_before', 'member', m.line_user_id,
         left('【預約提醒】' || E'\n日期：' ||
           to_char(b.start_at, 'YYYY/MM/DD') || E'\n時段：' ||
           to_char(b.start_at, 'HH24:MI') || '（台北時間）' ||
           E'\n請準時到場；如需調整請至預約頁操作。', 2200),
         b.start_at,
         ((b.start_at::date - 1) + b.reminder_time) at time zone 'Asia/Taipei'
    from public.bookings b join public.members m on m.id = b.member_id
   where b.status = 'confirmed' and b.cancellation_requested_at is null
     and b.reminder_enabled
     and b.start_at::date = v_today + 1
     and m.is_test_account is not true and m.line_user_id ~ '^U[0-9a-f]{32}$'
  on conflict (event_key) where event_key ~ ':reminder:day_before$'
  do update set recipient = excluded.recipient,
                message_text = excluded.message_text,
                reminder_start_at = excluded.reminder_start_at,
                next_attempt_at = excluded.next_attempt_at,
                status = 'pending', last_error = null
    where booking_notifications.outbox.status in ('pending', 'skipped')
      and booking_notifications.outbox.attempt_count = 0
      and booking_notifications.outbox.first_attempt_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $reminder_sync$;
revoke all on function booking_notifications.sync_day_before_reminders() from public, anon, authenticated;

-- Final safety gate immediately before dispatch: no global setting and no opted-out booking.
create or replace function public.skip_invalid_booking_reminder(p_id uuid, p_attempt integer)
returns boolean language plpgsql security definer set search_path = '' as $reminder_guard$
declare
  v_job booking_notifications.outbox%rowtype;
  v_start timestamp without time zone;
  v_due timestamptz;
  v_valid boolean;
begin
  select * into v_job from booking_notifications.outbox
   where id = p_id and status = 'sending' and attempt_count = p_attempt for update;
  if not found then return true; end if;
  if v_job.event_key !~ ':reminder:day_before$' then return false; end if;
  select b.start_at,
         ((b.start_at::date - 1) + b.reminder_time) at time zone 'Asia/Taipei',
         b.reminder_enabled
         and b.status = 'confirmed' and b.cancellation_requested_at is null
         and m.is_test_account is not true and m.line_user_id = v_job.recipient
         and c.enabled
    into v_start, v_due, v_valid
    from public.bookings b join public.members m on m.id = b.member_id
    cross join booking_notifications.config c
   where b.id = v_job.booking_id and c.id;
  if coalesce(v_valid, false) and v_start = v_job.reminder_start_at then
    if (now() at time zone 'Asia/Taipei')::date = v_start::date - 1
       and now() >= v_due then return false; end if;
  end if;
  update booking_notifications.outbox
     set status = 'skipped', last_error = 'Reminder no longer eligible'
   where id = p_id and status = 'sending' and attempt_count = p_attempt;
  return true;
end $reminder_guard$;
revoke all on function public.skip_invalid_booking_reminder(uuid,integer) from public,anon,authenticated;
grant execute on function public.skip_invalid_booking_reminder(uuid,integer) to service_role;
