-- Realtime invalidation for booking receipt lifecycle.
-- Do not publish booking_receipts directly: it contains member/storage/hash metadata.
-- Emit only a coarse admin invalidation event through the existing realtime_events channel.

create or replace function public.notify_booking_receipt_realtime_change()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
declare
  v_event_type text;
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;

  v_event_type := case new.status
    when 'awaiting_review' then 'booking.receipt.awaiting_review'
    when 'bound' then 'booking.receipt.bound'
    when 'failed' then 'booking.receipt.failed'
    when 'deleted' then 'booking.receipt.deleted'
    else null
  end;

  if v_event_type is not null then
    perform public.emit_realtime_invalidation(array['admin'], v_event_type);
  end if;

  return new;
end;
$function$;

revoke all on function public.notify_booking_receipt_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_booking_receipt_realtime_change() to service_role;

drop trigger if exists realtime_booking_receipt_change on public.booking_receipts;
create trigger realtime_booking_receipt_change
after insert or update of status on public.booking_receipts
for each row execute function public.notify_booking_receipt_realtime_change();
