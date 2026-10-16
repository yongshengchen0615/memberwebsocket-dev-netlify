-- Transactional realtime invalidation for admin-managed data.
--
-- The browser clients subscribe to public.realtime_events using only the
-- publishable key.  Invalidation rows therefore contain no member PII; they
-- only tell a surface to refetch its authorized bootstrap payload.

create or replace function public.emit_realtime_invalidation(
  p_scopes text[],
  p_event_type text
)
returns void
language plpgsql
set search_path = 'public'
as $function$
begin
  insert into public.realtime_events(scope, event_type)
  select distinct scope_value, left(coalesce(nullif(p_event_type, ''), 'data.changed'), 120)
  from unnest(coalesce(p_scopes, array[]::text[])) as scope_value
  where scope_value in ('member', 'points', 'event', 'calendar', 'admin', 'all');
end;
$function$;

revoke all on function public.emit_realtime_invalidation(text[], text) from public, anon, authenticated;
grant execute on function public.emit_realtime_invalidation(text[], text) to service_role;

-- Admin configuration tables are server-authoritative.  Emit the invalidation
-- in the same database transaction as the write so alternate Edge Function
-- routes cannot forget to notify connected clients.
create or replace function public.notify_admin_config_realtime_change()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
declare
  v_scopes text[];
  v_event_type text := 'admin.db.' || tg_table_name || '.' || lower(tg_op);
begin
  case tg_table_name
    when 'membership_tier_settings' then
      v_scopes := array['member', 'points', 'event', 'calendar', 'admin'];
    when 'point_cards' then
      v_scopes := array['points', 'admin'];
    when 'point_card_rewards' then
      v_scopes := array['points', 'admin'];
    when 'ticket_templates' then
      v_scopes := array['points', 'admin'];
    when 'event_tickets' then
      v_scopes := array['event', 'admin'];
    when 'calendar_items' then
      v_scopes := array['calendar', 'admin'];
    when 'grant_message_presets' then
      v_scopes := array['admin'];
    else
      v_scopes := array['admin'];
  end case;

  perform public.emit_realtime_invalidation(v_scopes, v_event_type);
  return null;
end;
$function$;

revoke all on function public.notify_admin_config_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_admin_config_realtime_change() to service_role;

-- One event per SQL statement, not one event per affected row.
drop trigger if exists realtime_membership_tier_settings_change on public.membership_tier_settings;
create trigger realtime_membership_tier_settings_change
after insert or update or delete on public.membership_tier_settings
for each statement execute function public.notify_admin_config_realtime_change();

drop trigger if exists realtime_point_cards_change on public.point_cards;
create trigger realtime_point_cards_change
after insert or update or delete on public.point_cards
for each statement execute function public.notify_admin_config_realtime_change();

drop trigger if exists realtime_point_card_rewards_change on public.point_card_rewards;
create trigger realtime_point_card_rewards_change
after insert or update or delete on public.point_card_rewards
for each statement execute function public.notify_admin_config_realtime_change();

drop trigger if exists realtime_ticket_templates_change on public.ticket_templates;
create trigger realtime_ticket_templates_change
after insert or update or delete on public.ticket_templates
for each statement execute function public.notify_admin_config_realtime_change();

drop trigger if exists realtime_event_tickets_change on public.event_tickets;
create trigger realtime_event_tickets_change
after insert or update or delete on public.event_tickets
for each statement execute function public.notify_admin_config_realtime_change();

drop trigger if exists realtime_calendar_items_change on public.calendar_items;
create trigger realtime_calendar_items_change
after insert or update or delete on public.calendar_items
for each statement execute function public.notify_admin_config_realtime_change();

drop trigger if exists realtime_grant_message_presets_change on public.grant_message_presets;
create trigger realtime_grant_message_presets_change
after insert or update or delete on public.grant_message_presets
for each statement execute function public.notify_admin_config_realtime_change();

-- Account status is user-visible, but members is also updated during normal
-- login/profile flows.  Only invalidate when the actual account status changes.
create or replace function public.notify_member_status_realtime_change()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
begin
  if old.status is distinct from new.status then
    perform public.emit_realtime_invalidation(
      array['member', 'points', 'event', 'calendar', 'admin'],
      'admin.db.members.status'
    );
  end if;
  return new;
end;
$function$;

revoke all on function public.notify_member_status_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_member_status_realtime_change() to service_role;

drop trigger if exists realtime_member_status_change on public.members;
create trigger realtime_member_status_change
after update of status on public.members
for each row execute function public.notify_member_status_realtime_change();

-- Unified member grants run through grant-automation, which bypasses the main
-- API's emitRealtime() call.  The atomic grant RPC already records this audit
-- event in the same transaction, so use it as the reliable commit boundary.
create or replace function public.notify_admin_grant_realtime_change()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
begin
  if new.action = 'admin.member-grants.add'
     and new.result = 'success'
     and coalesce(new.detail ->> 'applied', 'false') = 'true' then
    perform public.emit_realtime_invalidation(
      array['member', 'points', 'event', 'calendar', 'admin'],
      'admin.member-grants.add'
    );
  end if;
  return new;
end;
$function$;

revoke all on function public.notify_admin_grant_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_admin_grant_realtime_change() to service_role;

drop trigger if exists realtime_admin_grant_change on public.audit_logs;
create trigger realtime_admin_grant_change
after insert on public.audit_logs
for each row
when (new.action = 'admin.member-grants.add' and new.result = 'success')
execute function public.notify_admin_grant_realtime_change();
