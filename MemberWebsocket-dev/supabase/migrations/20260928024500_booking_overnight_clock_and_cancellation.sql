-- The opening date remains selectable until an overnight shift closes.
begin;

create function public.booking_business_date(p_now timestamp without time zone, p_open time, p_close time)
returns date language sql immutable strict set search_path = public, pg_temp as $$
  select p_now::date - case when p_close < p_open and p_now::time < p_close then 1 else 0 end
$$;
revoke all on function public.booking_business_date(timestamp without time zone,time,time) from public,anon,authenticated;
grant execute on function public.booking_business_date(timestamp without time zone,time,time) to service_role;

create or replace function public.enforce_booking_advance_window()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_settings public.booking_settings%rowtype;
  v_today date;
begin
  if tg_op = 'UPDATE' and new.booking_date is not distinct from old.booking_date then return new; end if;
  select * into v_settings from public.booking_settings where id = 1;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  v_today := public.booking_business_date(clock_timestamp() at time zone 'Asia/Taipei',
    v_settings.work_start_time,v_settings.work_end_time);
  if new.booking_date < v_today + coalesce(v_settings.min_advance_days,0) then raise exception 'BOOKING_TOO_EARLY'; end if;
  if coalesce(v_settings.max_advance_days,0) > 0
     and new.booking_date > v_today + v_settings.max_advance_days then raise exception 'BOOKING_TOO_FAR'; end if;
  return new;
end; $$;

create or replace function public.enforce_booking_live_clock()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status in ('pending','confirmed') and
     (new.booking_date + new.start_time + (case when new.starts_next_day then interval '1 day' else interval '0 days' end))
       <= (clock_timestamp() at time zone 'Asia/Taipei') then
    raise exception 'BOOKING_TIME_PASSED';
  end if;
  return new;
end; $$;
-- BEFORE triggers fire in name order; the rollover flag must be set before this guard.
drop trigger bookings_enforce_live_clock on public.bookings;
create trigger bookings_zz_enforce_live_clock before insert or update of booking_date,start_time,status
  on public.bookings for each row execute function public.enforce_booking_live_clock();

do $migration$
declare v_signature regprocedure; v_def text; v_next text; v_name text;
begin
  select p.oid::regprocedure into v_signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='request_booking_cancellation';
  if not found then raise exception 'MISSING_CANCELLATION_RPC'; end if;
  v_def := pg_get_functiondef(v_signature);
  v_next := replace(v_def,
    'if v_booking.booking_date < v_today'||E'\n'||'     or (v_booking.booking_date = v_today and v_booking.start_time <= v_local_time) then',
    'if v_booking.start_at <= (clock_timestamp() at time zone ''Asia/Taipei'') then');
  if v_next = v_def then raise exception 'CANCELLATION_CLOCK_GUARD_CHANGED'; end if;
  execute v_next;

  foreach v_name in array array['create_booking_bundle_request','update_booking_bundle_request',
    'create_group_booking_request','update_group_booking_request'] loop
    select p.oid::regprocedure into v_signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name;
    if not found then raise exception 'MISSING_BOOKING_RPC: %',v_name; end if;
    v_def := pg_get_functiondef(v_signature);
    v_next := regexp_replace(v_def,
      'p_booking_date < v_today \+ coalesce\(v_settings.min_advance_days,\s*0\)',
      'p_booking_date < public.booking_business_date(clock_timestamp() at time zone ''Asia/Taipei'',v_settings.work_start_time,v_settings.work_end_time) + coalesce(v_settings.min_advance_days,0)');
    if v_next = v_def then raise exception 'BOOKING_ADVANCE_GUARD_CHANGED: %',v_name; end if;
    execute v_next;
  end loop;
end $migration$;

notify pgrst, 'reload schema';
commit;
