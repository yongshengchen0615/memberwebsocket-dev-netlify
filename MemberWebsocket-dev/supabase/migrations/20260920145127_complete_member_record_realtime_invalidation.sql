create or replace function public.notify_member_record_realtime_change()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
declare
  v_scopes text[];
  v_event_type text := 'member-record.db.' || tg_table_name || '.' || lower(tg_op);
begin
  case tg_table_name
    when 'event_ticket_claims' then
      v_scopes := array['event','admin'];
    when 'booking_completion_settlements' then
      v_scopes := array['member','admin'];
    else
      v_scopes := array['admin'];
  end case;

  perform public.emit_realtime_invalidation(v_scopes, v_event_type);
  return null;
end;
$function$;

revoke all on function public.notify_member_record_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_member_record_realtime_change() to service_role;

drop trigger if exists realtime_event_ticket_claims_member_record_change on public.event_ticket_claims;
create trigger realtime_event_ticket_claims_member_record_change
after insert or update or delete on public.event_ticket_claims
for each statement execute function public.notify_member_record_realtime_change();

drop trigger if exists realtime_booking_completion_settlements_member_record_change on public.booking_completion_settlements;
create trigger realtime_booking_completion_settlements_member_record_change
after insert or update or delete on public.booking_completion_settlements
for each statement execute function public.notify_member_record_realtime_change();
