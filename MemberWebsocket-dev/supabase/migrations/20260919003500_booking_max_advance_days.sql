-- Booking shared setting: optional maximum number of days into the future a member may book.
-- max_advance_days = 0 means no upper bound.

alter table public.booking_settings
  add column if not exists max_advance_days integer not null default 0;

alter table public.booking_settings
  drop constraint if exists booking_settings_max_advance_days_check;
alter table public.booking_settings
  add constraint booking_settings_max_advance_days_check
  check (max_advance_days between 0 and 365);

alter table public.booking_settings
  drop constraint if exists booking_settings_advance_window_check;
alter table public.booking_settings
  add constraint booking_settings_advance_window_check
  check (max_advance_days = 0 or max_advance_days >= min_advance_days);

comment on column public.booking_settings.max_advance_days is
  'Maximum number of days from today that a member may book. 0 means unlimited.';

-- New overload used by current booking-admin-api. The previous overload is
-- intentionally retained so an older deployed function can continue saving
-- unrelated shared settings without resetting max_advance_days.
create or replace function public.save_booking_shared_settings(
  p_work_start_time time without time zone,
  p_work_end_time time without time zone,
  p_min_advance_days integer,
  p_max_advance_days integer,
  p_booking_notice text,
  p_expected_updated_at timestamptz default null,
  p_actor text default null
)
returns public.booking_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current public.booking_settings%rowtype;
  v_saved public.booking_settings%rowtype;
  v_notice text := coalesce(p_booking_notice, '');
begin
  select * into v_current
  from public.booking_settings
  where id = 1
  for update;

  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  if p_expected_updated_at is not null and v_current.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_SETTINGS_CONFLICT';
  end if;
  if p_work_start_time is null or p_work_end_time is null
     or p_work_end_time <= p_work_start_time
     or p_work_end_time - p_work_start_time < interval '30 minutes' then
    raise exception 'INVALID_WORK_HOURS';
  end if;
  if p_min_advance_days is null or p_min_advance_days < 0 or p_min_advance_days > 365 then
    raise exception 'INVALID_ADVANCE_DAYS';
  end if;
  if p_max_advance_days is null or p_max_advance_days < 0 or p_max_advance_days > 365 then
    raise exception 'INVALID_MAX_ADVANCE_DAYS';
  end if;
  if p_max_advance_days > 0 and p_max_advance_days < p_min_advance_days then
    raise exception 'INVALID_ADVANCE_WINDOW';
  end if;
  if char_length(v_notice) > 2000 then raise exception 'INVALID_BOOKING_NOTICE'; end if;

  update public.booking_settings
  set work_start_time = p_work_start_time,
      work_end_time = p_work_end_time,
      min_advance_days = p_min_advance_days,
      max_advance_days = p_max_advance_days,
      booking_notice = v_notice,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = 1
  returning * into v_saved;

  return v_saved;
end;
$$;

revoke all on function public.save_booking_shared_settings(
  time without time zone,
  time without time zone,
  integer,
  integer,
  text,
  timestamptz,
  text
) from public, anon, authenticated;
grant execute on function public.save_booking_shared_settings(
  time without time zone,
  time without time zone,
  integer,
  integer,
  text,
  timestamptz,
  text
) to service_role;

comment on function public.save_booking_shared_settings(
  time without time zone,
  time without time zone,
  integer,
  integer,
  text,
  timestamptz,
  text
) is 'Atomically saves booking hours, minimum/maximum advance-day policy, and member-facing booking notice with optimistic concurrency.';

-- Compatibility admin endpoint uses this RPC. Keep the existing overload and
-- add a max-advance-aware overload for the updated Edge Function.
create or replace function public.save_booking_settings_with_service_types(
  p_work_start_time time without time zone,
  p_work_end_time time without time zone,
  p_min_advance_days integer,
  p_max_advance_days integer,
  p_service_types text[],
  p_expected_updated_at timestamptz default null,
  p_actor text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_updated_at timestamptz;
begin
  select updated_at
    into v_current_updated_at
  from public.booking_settings
  where id = 1
  for update;

  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;

  if p_expected_updated_at is not null
     and v_current_updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_SETTINGS_CONFLICT';
  end if;

  if p_work_end_time <= p_work_start_time
     or extract(epoch from (p_work_end_time - p_work_start_time)) < 1800 then
    raise exception 'INVALID_WORK_HOURS';
  end if;

  if p_min_advance_days < 0 or p_min_advance_days > 365 then
    raise exception 'INVALID_ADVANCE_DAYS';
  end if;

  if p_max_advance_days < 0 or p_max_advance_days > 365 then
    raise exception 'INVALID_MAX_ADVANCE_DAYS';
  end if;

  if p_max_advance_days > 0 and p_max_advance_days < p_min_advance_days then
    raise exception 'INVALID_ADVANCE_WINDOW';
  end if;

  update public.booking_settings
  set work_start_time = p_work_start_time,
      work_end_time = p_work_end_time,
      min_advance_days = p_min_advance_days,
      max_advance_days = p_max_advance_days,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = 1;

  perform p_service_types;
end;
$$;

revoke all on function public.save_booking_settings_with_service_types(
  time without time zone,
  time without time zone,
  integer,
  integer,
  text[],
  timestamptz,
  text
) from public, anon, authenticated;
grant execute on function public.save_booking_settings_with_service_types(
  time without time zone,
  time without time zone,
  integer,
  integer,
  text[],
  timestamptz,
  text
) to service_role;

-- Database boundary: even a direct or stale client cannot create/move a booking
-- outside the configured advance window. Existing bookings are grandfathered
-- when an update does not change booking_date.
create or replace function public.enforce_booking_advance_window()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_settings public.booking_settings%rowtype;
  v_today date := (now() at time zone 'Asia/Taipei')::date;
begin
  if tg_op = 'UPDATE' and new.booking_date is not distinct from old.booking_date then
    return new;
  end if;

  select * into v_settings
  from public.booking_settings
  where id = 1;

  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;

  if new.booking_date < v_today + coalesce(v_settings.min_advance_days, 0) then
    raise exception 'BOOKING_TOO_EARLY';
  end if;

  if coalesce(v_settings.max_advance_days, 0) > 0
     and new.booking_date > v_today + v_settings.max_advance_days then
    raise exception 'BOOKING_TOO_FAR';
  end if;

  return new;
end;
$$;

drop trigger if exists booking_enforce_advance_window on public.bookings;
create trigger booking_enforce_advance_window
before insert or update of booking_date on public.bookings
for each row execute function public.enforce_booking_advance_window();

revoke all on function public.enforce_booking_advance_window() from public, anon, authenticated;
grant execute on function public.enforce_booking_advance_window() to service_role;

comment on function public.enforce_booking_advance_window() is
  'Database business-rule guard for booking_settings minimum/maximum advance days. max_advance_days=0 means unlimited.';

notify pgrst, 'reload schema';
