-- Calendar changes affect both the calendar surface and booking availability.
-- Include the member scope so an already-open booking calendar can refresh holidays.

create or replace function public.notify_admin_config_realtime_change()
returns trigger
language plpgsql
set search_path = public
as $$
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
      v_scopes := array['calendar', 'member', 'admin'];
    when 'grant_message_presets' then
      v_scopes := array['admin'];
    else
      v_scopes := array['admin'];
  end case;

  perform public.emit_realtime_invalidation(v_scopes, v_event_type);
  return null;
end;
$$;
