-- Propagate admin location/radius edits to *unredeemed* issued tickets.
-- Keep used ticket records immutable, and keep server geofencing authoritative.
create or replace function public.sync_available_point_tickets_for_reward(p_reward_id uuid)
returns integer language plpgsql security definer set search_path = 'public','pg_temp'
as $$
declare
  v_count integer := 0;
  v_template_status text;
begin
  select t.status into v_template_status
  from public.point_card_rewards r
  join public.ticket_templates t on t.id = r.ticket_template_id
  where r.id = p_reward_id;
  if not found then return 0; end if;
  if v_template_status <> 'active' then
    update public.point_tickets pt
      set status='cancelled', updated_at=now()
      where pt.reward_id=p_reward_id and pt.status='available';
    get diagnostics v_count = row_count;
    return v_count;
  end if;

  update public.point_tickets pt
    set ticket_template_id=t.id,
        threshold_stamps=r.threshold_stamps,
        ticket_type=t.ticket_type,
        ticket_title=t.title,
        ticket_description=t.description,
        usage_method=t.usage_method,
        usage_instructions=t.usage_instructions,
        prizes=t.prizes,
        requires_location=t.requires_location,
        redemption_locations=case when t.requires_location then t.redemption_locations else '[]'::jsonb end,
        updated_at=now()
  from public.point_card_rewards r
  join public.ticket_templates t on t.id=r.ticket_template_id
  where r.id=p_reward_id and pt.reward_id=r.id and pt.status='available';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

drop trigger if exists ticket_templates_sync_available_tickets on public.ticket_templates;
create trigger ticket_templates_sync_available_tickets
after update of title, ticket_type, description, usage_method, usage_instructions,
  prizes, status, requires_location, redemption_locations
on public.ticket_templates
for each row
when (
  old.title is distinct from new.title
  or old.ticket_type is distinct from new.ticket_type
  or old.description is distinct from new.description
  or old.usage_method is distinct from new.usage_method
  or old.usage_instructions is distinct from new.usage_instructions
  or old.prizes is distinct from new.prizes
  or old.status is distinct from new.status
  or old.requires_location is distinct from new.requires_location
  or old.redemption_locations is distinct from new.redemption_locations
)
execute function public.sync_available_point_tickets_after_template_update();

-- Reconcile previously issued point tickets with their current admin templates.
update public.point_tickets pt
set requires_location=t.requires_location,
    redemption_locations=case when t.requires_location then t.redemption_locations else '[]'::jsonb end,
    updated_at=now()
from public.ticket_templates t
where pt.ticket_template_id=t.id
  and pt.status='available'
  and (
    pt.requires_location is distinct from t.requires_location
    or pt.redemption_locations is distinct from
      (case when t.requires_location then t.redemption_locations else '[]'::jsonb end)
  );

-- Fixed event ticket instances also need to follow admin template location edits.
-- The existing BEFORE UPDATE trigger on event_tickets copies the template rule.
create or replace function public.sync_fixed_ticket_location_after_template_update()
returns trigger language plpgsql security invoker set search_path = 'public','pg_temp'
as $$
begin
  update public.event_tickets e set updated_at=now()
  where e.fixed_ticket_template_id=new.id and e.deleted_at is null
    and (
      e.requires_location is distinct from new.requires_location
      or e.redemption_locations is distinct from
        (case when new.requires_location then new.redemption_locations else '[]'::jsonb end)
    );
  return new;
end;
$$;

drop trigger if exists fixed_ticket_templates_sync_location on public.fixed_ticket_templates;
create trigger fixed_ticket_templates_sync_location
after update of requires_location, redemption_locations on public.fixed_ticket_templates
for each row when (
  old.requires_location is distinct from new.requires_location
  or old.redemption_locations is distinct from new.redemption_locations
)
execute function public.sync_fixed_ticket_location_after_template_update();
