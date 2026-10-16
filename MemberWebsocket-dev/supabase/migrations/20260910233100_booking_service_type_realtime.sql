-- Keep booking admin catalogs synchronized across concurrent admin sessions.
drop trigger if exists realtime_booking_service_types_change on public.booking_service_types;
create trigger realtime_booking_service_types_change
after insert or update or delete on public.booking_service_types
for each statement execute function public.notify_booking_realtime_change();
