-- Surface booking-reserved ticket state to member clients and enforce one active reservation per consumable ticket.

create unique index if not exists booking_benefit_selections_one_pending_ticket_idx
  on public.booking_benefit_selections(member_id, benefit_kind, benefit_ref)
  where status = 'pending'
    and benefit_kind in ('points','event');

create or replace function public.notify_booking_benefit_selection_realtime_change()
returns trigger
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $function$
begin
  perform public.emit_realtime_invalidation(
    array['booking','points','event','admin'],
    'data.db.booking_benefit_selections.' || lower(tg_op)
  );
  return null;
end;
$function$;

revoke all on function public.notify_booking_benefit_selection_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_booking_benefit_selection_realtime_change() to service_role;

drop trigger if exists realtime_booking_benefit_selections_change on public.booking_benefit_selections;
create trigger realtime_booking_benefit_selections_change
after insert or update or delete on public.booking_benefit_selections
for each statement
execute function public.notify_booking_benefit_selection_realtime_change();
