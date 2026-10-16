-- Reminders use the actual Taipei appointment start, independent of the business date.
alter table public.booking_settings
  add column reminder_enabled boolean not null default false,
  add column reminder_time time without time zone not null default time '18:00';

alter table public.booking_settings
  add constraint booking_settings_reminder_minute_check
  check (extract(second from reminder_time) = 0);

alter table booking_notifications.outbox
  add column reminder_start_at timestamp without time zone;

create unique index outbox_day_before_reminder_once
  on booking_notifications.outbox(event_key)
  where event_key ~ ':reminder:day_before$';

create or replace function public.save_booking_shared_settings_v4(
  p_work_start_time time, p_work_end_time time, p_slot_interval_minutes integer,
  p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text,
  p_store_service_minutes integer, p_reminder_enabled boolean, p_reminder_time time,
  p_expected_updated_at timestamptz, p_actor text
) returns public.booking_settings
language plpgsql security definer set search_path = '' as $function$
declare v_before public.booking_settings%rowtype;
        v_after public.booking_settings%rowtype;
begin
  if p_reminder_enabled is null or p_reminder_time is null
     or extract(second from p_reminder_time) <> 0 then
    raise exception 'INVALID_REMINDER_SETTINGS';
  end if;
  -- v3 locks the settings row, validates the actor and all existing settings,
  -- and records the existing settings audit in this same transaction.
  select * into v_before from public.booking_settings where id = 1;
  perform public.save_booking_shared_settings_v3(
    p_work_start_time, p_work_end_time, p_slot_interval_minutes,
    p_min_advance_days, p_max_advance_days, p_booking_notice,
    p_store_service_minutes, p_expected_updated_at, p_actor
  );
  update public.booking_settings
     set reminder_enabled = p_reminder_enabled, reminder_time = p_reminder_time,
         updated_by = p_actor
   where id = 1 returning * into v_after;
  insert into public.booking_audit_events
    (actor_line_user_id, actor_role, action, target_type, target_id, result, metadata)
  values (p_actor, 'admin', 'BOOKING_REMINDER_SETTINGS_UPDATED',
          'booking_settings', '1', 'success',
          jsonb_build_object('before', jsonb_build_object(
            'enabled', v_before.reminder_enabled, 'time', v_before.reminder_time),
            'after', jsonb_build_object(
            'enabled', v_after.reminder_enabled, 'time', v_after.reminder_time)));
  return v_after;
end $function$;
revoke all on function public.save_booking_shared_settings_v4(
  time,time,integer,integer,integer,text,integer,boolean,time,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.save_booking_shared_settings_v4(
  time,time,integer,integer,integer,text,integer,boolean,time,timestamptz,text)
  to service_role;

create or replace function booking_notifications.sync_day_before_reminders()
returns integer language plpgsql security definer set search_path = '' as $function$
declare v_count integer := 0;
        v_today date := (now() at time zone 'Asia/Taipei')::date;
        v_settings public.booking_settings%rowtype;
begin
  if not pg_try_advisory_xact_lock(738491205315::bigint) then return 0; end if;
  select * into v_settings from public.booking_settings where id = 1;
  if not found then return 0; end if;

  -- A pending, never attempted row follows a reschedule or a changed reminder time.
  update booking_notifications.outbox q
     set reminder_start_at = b.start_at,
         recipient = m.line_user_id,
         message_text = left('【預約提醒】' || E'\n日期：' ||
           to_char(b.start_at, 'YYYY/MM/DD') || E'\n時段：' ||
           to_char(b.start_at, 'HH24:MI') || '（台北時間）' ||
           E'\n請準時到場；如需調整請至預約頁操作。', 2200),
         next_attempt_at = ((b.start_at::date - 1) + v_settings.reminder_time)
                           at time zone 'Asia/Taipei',
         last_error = null
    from public.bookings b join public.members m on m.id = b.member_id
   where q.booking_id = b.id and q.event_key ~ ':reminder:day_before$'
     and q.status = 'pending' and q.attempt_count = 0 and q.first_attempt_at is null
     and b.status = 'confirmed' and b.cancellation_requested_at is null
     and b.start_at::date > v_today
     and m.is_test_account is not true and m.line_user_id ~ '^U[0-9a-f]{32}$'
     and (q.reminder_start_at is distinct from b.start_at
          or q.recipient is distinct from m.line_user_id
          or q.next_attempt_at is distinct from
              (((b.start_at::date - 1) + v_settings.reminder_time) at time zone 'Asia/Taipei'));

  if not v_settings.reminder_enabled or not coalesce(
      (select enabled from booking_notifications.config where id), false) then
    return 0;
  end if;

  insert into booking_notifications.outbox
    (booking_id, event_key, channel, recipient, message_text, reminder_start_at, next_attempt_at)
  select b.id, b.id::text || ':reminder:day_before', 'member', m.line_user_id,
         left('【預約提醒】' || E'\n日期：' ||
           to_char(b.start_at, 'YYYY/MM/DD') || E'\n時段：' ||
           to_char(b.start_at, 'HH24:MI') || '（台北時間）' ||
           E'\n請準時到場；如需調整請至預約頁操作。', 2200),
         b.start_at,
         ((b.start_at::date - 1) + v_settings.reminder_time) at time zone 'Asia/Taipei'
    from public.bookings b join public.members m on m.id = b.member_id
   where b.status = 'confirmed' and b.cancellation_requested_at is null
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
end $function$;
revoke all on function booking_notifications.sync_day_before_reminders() from public, anon, authenticated;

-- Called only by the authenticated dispatch Edge Function immediately before LINE.
create or replace function public.skip_invalid_booking_reminder(
  p_id uuid, p_attempt integer
) returns boolean language plpgsql security definer set search_path = '' as $function$
declare v_job booking_notifications.outbox%rowtype;
        v_start timestamp without time zone;
        v_due timestamptz;
        v_valid boolean;
begin
  select * into v_job from booking_notifications.outbox
   where id = p_id and status = 'sending' and attempt_count = p_attempt for update;
  if not found then return true; end if;
  if v_job.event_key !~ ':reminder:day_before$' then return false; end if;
  select b.start_at,
         b.status = 'confirmed' and b.cancellation_requested_at is null
         and m.is_test_account is not true and m.line_user_id = v_job.recipient
         and s.reminder_enabled and c.enabled
    into v_start, v_valid
    from public.bookings b join public.members m on m.id = b.member_id
    cross join public.booking_settings s
    cross join booking_notifications.config c
   where b.id = v_job.booking_id and s.id = 1 and c.id;
  if coalesce(v_valid, false) and v_start = v_job.reminder_start_at then
    select ((v_start::date - 1) + reminder_time) at time zone 'Asia/Taipei'
      into v_due from public.booking_settings where id = 1;
    if (now() at time zone 'Asia/Taipei')::date = v_start::date - 1
       and now() >= v_due then return false; end if;
  end if;
  update booking_notifications.outbox
     set status = 'skipped', last_error = 'Reminder no longer eligible'
   where id = p_id and status = 'sending' and attempt_count = p_attempt;
  return true;
end $function$;
revoke all on function public.skip_invalid_booking_reminder(uuid,integer)
  from public, anon, authenticated;
grant execute on function public.skip_invalid_booking_reminder(uuid,integer)
  to service_role;

select cron.schedule('sync-booking-day-before-reminders', '* * * * *',
  'select booking_notifications.sync_day_before_reminders();');
