-- Booking shared notice and holiday booking guard.

alter table public.booking_settings
  add column if not exists booking_notice text not null default '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'booking_settings_booking_notice_length'
      and conrelid = 'public.booking_settings'::regclass
  ) then
    alter table public.booking_settings
      add constraint booking_settings_booking_notice_length
      check (char_length(booking_notice) <= 2000);
  end if;
end
$$;

comment on column public.booking_settings.booking_notice is
  'Member-facing booking instructions. Plain text; line breaks are preserved by clients.';

create or replace function public.save_booking_shared_settings(
  p_work_start_time time without time zone,
  p_work_end_time time without time zone,
  p_min_advance_days integer,
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
  if char_length(v_notice) > 2000 then raise exception 'INVALID_BOOKING_NOTICE'; end if;

  update public.booking_settings
  set work_start_time = p_work_start_time,
      work_end_time = p_work_end_time,
      min_advance_days = p_min_advance_days,
      booking_notice = v_notice,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = 1
  returning * into v_saved;

  return v_saved;
end;
$$;

revoke all on function public.save_booking_shared_settings(time without time zone, time without time zone, integer, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.save_booking_shared_settings(time without time zone, time without time zone, integer, text, timestamptz, text)
  to service_role;

comment on function public.save_booking_shared_settings(time without time zone, time without time zone, integer, text, timestamptz, text) is
  'Atomically saves booking hours, advance-days policy, and member-facing booking notice with optimistic concurrency.';

create or replace function public.prevent_booking_on_active_holiday()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.calendar_items
    where item_type = 'holiday'
      and status = 'active'
      and starts_on <= new.booking_date
      and ends_on >= new.booking_date
  ) then
    raise exception 'BOOKING_HOLIDAY';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_prevent_active_holiday on public.bookings;
create trigger booking_prevent_active_holiday
before insert or update of booking_date on public.bookings
for each row execute function public.prevent_booking_on_active_holiday();

comment on function public.prevent_booking_on_active_holiday() is
  'Database authorization/business-rule boundary that rejects new bookings on active calendar holidays.';
