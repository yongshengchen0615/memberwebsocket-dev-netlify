-- Keep calendar batch RPC backward compatible with the admin client payload.
-- Older/current cached clients send `operation`; the canonical RPC field is `action`.
-- Prefer `action` when both are present and retain the existing service_role-only execution boundary.

create or replace function public.apply_calendar_batch(
  p_actor_line_user_id text,
  p_operations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_op jsonb;
  v_item jsonb;
  v_action text;
  v_id text;
  v_expected timestamptz;
  v_result jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) < 1 or jsonb_array_length(p_operations) > 20 then
    raise exception 'INVALID_CALENDAR_BATCH';
  end if;

  for v_op in select value from jsonb_array_elements(p_operations)
  loop
    v_action := coalesce(nullif(v_op->>'action', ''), nullif(v_op->>'operation', ''), 'save');
    if v_action not in ('save', 'delete') then
      raise exception 'INVALID_CALENDAR_BATCH';
    end if;

    if v_action = 'delete' then
      v_id := coalesce(v_op->>'calendarItemId', v_op#>>'{calendarItem,calendarItemId}');
      v_expected := nullif(coalesce(v_op->>'expectedUpdatedAt', v_op#>>'{calendarItem,expectedUpdatedAt}'), '')::timestamptz;
      if not exists(select 1 from public.calendar_items where calendar_item_id = v_id for update) then
        raise exception 'CALENDAR_ITEM_NOT_FOUND';
      end if;
      if v_expected is not null and not exists(select 1 from public.calendar_items where calendar_item_id = v_id and updated_at = v_expected) then
        raise exception 'CONFLICT';
      end if;
    else
      v_item := coalesce(v_op->'calendarItem', v_op);
      v_id := nullif(v_item->>'calendarItemId', '');
      if v_id is not null then
        v_expected := nullif(coalesce(v_op->>'expectedUpdatedAt', v_item->>'expectedUpdatedAt'), '')::timestamptz;
        if not exists(select 1 from public.calendar_items where calendar_item_id = v_id for update) then
          raise exception 'CALENDAR_ITEM_NOT_FOUND';
        end if;
        if v_expected is not null and not exists(select 1 from public.calendar_items where calendar_item_id = v_id and updated_at = v_expected) then
          raise exception 'CONFLICT';
        end if;
      end if;
    end if;
  end loop;

  for v_op in select value from jsonb_array_elements(p_operations)
  loop
    v_action := coalesce(nullif(v_op->>'action', ''), nullif(v_op->>'operation', ''), 'save');
    if v_action = 'delete' then
      v_id := coalesce(v_op->>'calendarItemId', v_op#>>'{calendarItem,calendarItemId}');
      delete from public.calendar_items where calendar_item_id = v_id;
      v_result := v_result || jsonb_build_array(jsonb_build_object('action', 'delete', 'calendarItemId', v_id));
    else
      v_item := coalesce(v_op->'calendarItem', v_op);
      v_id := nullif(v_item->>'calendarItemId', '');
      if v_id is null then
        v_id := public.new_public_id('CAL');
        insert into public.calendar_items(
          calendar_item_id, title, item_type, description, starts_on, ends_on, status, accent, allowed_tier_keys, link_label, link_url, created_by, updated_by
        ) values(
          v_id, trim(v_item->>'title'), v_item->>'itemType', coalesce(v_item->>'description', ''), (v_item->>'startsOn')::date,
          nullif(v_item->>'endsOn', '')::date, v_item->>'status', v_item->>'accent',
          coalesce(array(select jsonb_array_elements_text(v_item->'allowedTierKeys')), array[]::text[]),
          coalesce(v_item->>'linkLabel', ''), coalesce(v_item->>'linkUrl', ''), p_actor_line_user_id, p_actor_line_user_id
        );
      else
        update public.calendar_items set
          title = trim(v_item->>'title'),
          item_type = v_item->>'itemType',
          description = coalesce(v_item->>'description', ''),
          starts_on = (v_item->>'startsOn')::date,
          ends_on = nullif(v_item->>'endsOn', '')::date,
          status = v_item->>'status',
          accent = v_item->>'accent',
          allowed_tier_keys = coalesce(array(select jsonb_array_elements_text(v_item->'allowedTierKeys')), array[]::text[]),
          link_label = coalesce(v_item->>'linkLabel', ''),
          link_url = coalesce(v_item->>'linkUrl', ''),
          updated_by = p_actor_line_user_id,
          updated_at = now()
        where calendar_item_id = v_id;
      end if;
      v_result := v_result || jsonb_build_array(jsonb_build_object('action', 'save', 'calendarItemId', v_id));
    end if;
  end loop;

  return v_result;
end;
$function$;

revoke all on function public.apply_calendar_batch(text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_calendar_batch(text, jsonb) to service_role;
