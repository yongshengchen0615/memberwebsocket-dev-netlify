-- Complete transactional realtime invalidation coverage for independently
-- mutable user-visible data. Realtime events are invalidation signals only;
-- clients refetch authoritative state after receiving them.

create or replace function public.notify_surface_realtime_change()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
declare
  v_scopes text[];
  v_event_type text := 'data.db.' || tg_table_name || '.' || lower(tg_op);
begin
  case tg_table_name
    when 'point_card_settings' then
      v_scopes := array['points','admin'];
    when 'point_balances' then
      v_scopes := array['points','admin'];
    when 'point_entries' then
      v_scopes := array['points','admin'];
    when 'point_tickets' then
      v_scopes := array['points','admin'];
    when 'service_time_entries' then
      v_scopes := array['member','points','event','calendar','admin'];
    when 'fixed_ticket_templates' then
      v_scopes := array['admin'];
    else
      v_scopes := array['admin'];
  end case;

  perform public.emit_realtime_invalidation(v_scopes, v_event_type);
  return null;
end;
$function$;

revoke all on function public.notify_surface_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_surface_realtime_change() to service_role;

drop trigger if exists realtime_point_card_settings_change on public.point_card_settings;
create trigger realtime_point_card_settings_change
after insert or update or delete on public.point_card_settings
for each statement execute function public.notify_surface_realtime_change();

drop trigger if exists realtime_point_balances_change on public.point_balances;
create trigger realtime_point_balances_change
after insert or update or delete on public.point_balances
for each statement execute function public.notify_surface_realtime_change();

drop trigger if exists realtime_point_entries_change on public.point_entries;
create trigger realtime_point_entries_change
after insert or update or delete on public.point_entries
for each statement execute function public.notify_surface_realtime_change();

drop trigger if exists realtime_point_tickets_change on public.point_tickets;
create trigger realtime_point_tickets_change
after insert or update or delete on public.point_tickets
for each statement execute function public.notify_surface_realtime_change();

drop trigger if exists realtime_service_time_entries_change on public.service_time_entries;
create trigger realtime_service_time_entries_change
after insert or update or delete on public.service_time_entries
for each statement execute function public.notify_surface_realtime_change();

drop trigger if exists realtime_fixed_ticket_templates_change on public.fixed_ticket_templates;
create trigger realtime_fixed_ticket_templates_change
after insert or update or delete on public.fixed_ticket_templates
for each statement execute function public.notify_surface_realtime_change();

create or replace function public.notify_member_profile_realtime_change()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
declare
  v_scopes text[] := array['member','admin'];
begin
  if old.membership_status is distinct from new.membership_status
     or old.birthday is distinct from new.birthday then
    v_scopes := array['member','points','event','calendar','admin'];
  end if;

  perform public.emit_realtime_invalidation(v_scopes, 'member.db.members.profile');
  return new;
end;
$function$;

revoke all on function public.notify_member_profile_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_member_profile_realtime_change() to service_role;

drop trigger if exists realtime_member_profile_change on public.members;
create trigger realtime_member_profile_change
after update of display_name, membership_status, birthday, phone, surname, salutation on public.members
for each row
when (
  old.display_name is distinct from new.display_name
  or old.membership_status is distinct from new.membership_status
  or old.birthday is distinct from new.birthday
  or old.phone is distinct from new.phone
  or old.surname is distinct from new.surname
  or old.salutation is distinct from new.salutation
)
execute function public.notify_member_profile_realtime_change();

drop trigger if exists realtime_booking_items_change on public.booking_items;
create trigger realtime_booking_items_change
after insert or update or delete on public.booking_items
for each statement execute function public.notify_booking_realtime_change();

drop trigger if exists realtime_booking_technicians_change on public.booking_technicians;
create trigger realtime_booking_technicians_change
after insert or update or delete on public.booking_technicians
for each statement execute function public.notify_booking_realtime_change();

drop trigger if exists realtime_booking_participants_change on public.booking_participants;
create trigger realtime_booking_participants_change
after insert or update or delete on public.booking_participants
for each statement execute function public.notify_booking_realtime_change();

drop trigger if exists realtime_booking_participant_items_change on public.booking_participant_items;
create trigger realtime_booking_participant_items_change
after insert or update or delete on public.booking_participant_items
for each statement execute function public.notify_booking_realtime_change();

drop trigger if exists realtime_booking_participant_reservations_change on public.booking_participant_reservations;
create trigger realtime_booking_participant_reservations_change
after insert or update or delete on public.booking_participant_reservations
for each statement execute function public.notify_booking_realtime_change();
