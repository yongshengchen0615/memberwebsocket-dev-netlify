-- A calendar item with ends_on = null represents a single-day item.
-- Treat its effective end date as starts_on for booking availability and enforcement.

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
      and coalesce(ends_on, starts_on) >= new.booking_date
  ) then
    raise exception 'BOOKING_HOLIDAY';
  end if;
  return new;
end;
$$;

comment on function public.prevent_booking_on_active_holiday() is
  'Rejects bookings on active holidays; null ends_on is treated as a single-day holiday ending on starts_on.';
