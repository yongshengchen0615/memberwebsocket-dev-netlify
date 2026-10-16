create or replace function public.enforce_booking_advance_window()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_settings public.booking_settings%rowtype;
  v_today date;
begin
  if tg_op = 'UPDATE' and new.booking_date is not distinct from old.booking_date then
    return new;
  end if;

  -- Business-date checks must use the wall clock at row-mutation time. PostgreSQL
  -- now() is pinned to transaction start and can become stale while waiting on locks.
  v_today := (clock_timestamp() at time zone 'Asia/Taipei')::date;

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
$function$;

create or replace function public.enforce_booking_live_clock()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_now timestamp without time zone;
begin
  if new.status not in ('pending', 'confirmed') then
    return new;
  end if;

  -- Re-evaluate after any statement/advisory-lock wait so a request cannot cross
  -- its start time and still commit based on a stale transaction timestamp.
  v_now := clock_timestamp() at time zone 'Asia/Taipei';

  if (new.booking_date + new.start_time) <= v_now then
    raise exception 'BOOKING_TIME_PASSED';
  end if;

  return new;
end;
$function$;

drop trigger if exists bookings_enforce_live_clock on public.bookings;
create trigger bookings_enforce_live_clock
before insert or update of booking_date, start_time, status
on public.bookings
for each row
execute function public.enforce_booking_live_clock();

revoke all on function public.enforce_booking_advance_window() from public, anon, authenticated;
revoke all on function public.enforce_booking_live_clock() from public, anon, authenticated;
grant execute on function public.enforce_booking_advance_window() to service_role;
grant execute on function public.enforce_booking_live_clock() to service_role;
