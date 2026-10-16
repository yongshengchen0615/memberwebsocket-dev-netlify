-- Fix schema drift between configurable booking slot intervals and the booking row boundary guard.
-- booking_settings.slot_interval_minutes supports 5-minute increments and booking_slot_fits()
-- enforces the configured interval. This table-level check only enforces the shared base granularity.

alter table public.bookings
  drop constraint if exists bookings_start_boundary_check;

alter table public.bookings
  add constraint bookings_start_boundary_check
  check (
    extract(second from start_time) = 0
    and extract(minute from start_time)::integer % 5 = 0
  );
