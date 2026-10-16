-- Realtime invalidation for booking cancellation requests/reviews.
-- The booking row keeps its original pending/confirmed status while a member
-- cancellation request is awaiting admin review, so cancellation-specific
-- columns must also emit invalidation events.

create or replace function public.notify_booking_cancellation_realtime_change()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
begin
  if old.cancellation_requested_at is distinct from new.cancellation_requested_at
     or old.cancellation_reviewed_at is distinct from new.cancellation_reviewed_at
     or old.cancellation_decision is distinct from new.cancellation_decision then
    perform public.emit_realtime_invalidation(
      array['admin', 'member'],
      case
        when old.cancellation_requested_at is null and new.cancellation_requested_at is not null then 'booking.cancellation.requested'
        when new.cancellation_decision = 'approved' then 'booking.cancellation.approved'
        when new.cancellation_decision = 'rejected' then 'booking.cancellation.rejected'
        else 'booking.cancellation.changed'
      end
    );
  end if;
  return new;
end;
$function$;

revoke all on function public.notify_booking_cancellation_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_booking_cancellation_realtime_change() to service_role;

drop trigger if exists realtime_booking_cancellation_change on public.bookings;
create trigger realtime_booking_cancellation_change
after update of cancellation_requested_at, cancellation_reviewed_at, cancellation_decision on public.bookings
for each row execute function public.notify_booking_cancellation_realtime_change();
