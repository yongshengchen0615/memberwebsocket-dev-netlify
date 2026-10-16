-- Add reusable GPS redemption rules to every ticket source.
-- Current device coordinates are validated at redemption time and are never persisted.

alter table public.fixed_ticket_templates
  add column if not exists requires_location boolean not null default false,
  add column if not exists redemption_locations jsonb not null default '[]'::jsonb;

alter table public.ticket_templates
  add column if not exists requires_location boolean not null default false,
  add column if not exists redemption_locations jsonb not null default '[]'::jsonb;

alter table public.point_tickets
  add column if not exists requires_location boolean not null default false,
  add column if not exists redemption_locations jsonb not null default '[]'::jsonb;

alter table public.fixed_ticket_templates
  drop constraint if exists fixed_ticket_templates_location_rule_check,
  add constraint fixed_ticket_templates_location_rule_check check (
    (not requires_location and redemption_locations = '[]'::jsonb)
    or (requires_location and public.event_ticket_locations_valid(redemption_locations))
  );

alter table public.ticket_templates
  drop constraint if exists ticket_templates_location_rule_check,
  add constraint ticket_templates_location_rule_check check (
    (not requires_location and redemption_locations = '[]'::jsonb)
    or (requires_location and public.event_ticket_locations_valid(redemption_locations))
  );

alter table public.point_tickets
  drop constraint if exists point_tickets_location_rule_check,
  add constraint point_tickets_location_rule_check check (
    (not requires_location and redemption_locations = '[]'::jsonb)
    or (requires_location and public.event_ticket_locations_valid(redemption_locations))
  );

create or replace function public.apply_fixed_ticket_location_rule()
returns trigger
language plpgsql
security invoker
set search_path = 'public','pg_temp'
as $$
declare
  v_requires boolean;
  v_locations jsonb;
  v_first jsonb;
begin
  if new.fixed_ticket_template_id is null then
    return new;
  end if;

  select requires_location, redemption_locations
    into v_requires, v_locations
  from public.fixed_ticket_templates
  where id = new.fixed_ticket_template_id;

  if found then
    new.requires_location := coalesce(v_requires,false);
    new.redemption_locations := case when coalesce(v_requires,false) then coalesce(v_locations,'[]'::jsonb) else '[]'::jsonb end;
    v_first := case when new.requires_location then new.redemption_locations->0 else null end;
    new.redemption_latitude := case when v_first is null then null else (v_first->>'latitude')::numeric end;
    new.redemption_longitude := case when v_first is null then null else (v_first->>'longitude')::numeric end;
    new.redemption_radius_meters := case when v_first is null then null else (v_first->>'radiusMeters')::integer end;
  end if;
  return new;
end;
$$;

drop trigger if exists event_tickets_apply_fixed_location_rule on public.event_tickets;
create trigger event_tickets_apply_fixed_location_rule
before insert or update on public.event_tickets
for each row
when (new.fixed_ticket_template_id is not null)
execute function public.apply_fixed_ticket_location_rule();

update public.event_tickets e
set updated_at = e.updated_at
from public.fixed_ticket_templates t
where e.fixed_ticket_template_id = t.id;

create or replace function public.apply_point_ticket_location_rule()
returns trigger
language plpgsql
security invoker
set search_path = 'public','pg_temp'
as $$
declare
  v_requires boolean;
  v_locations jsonb;
begin
  if new.ticket_template_id is null then
    return new;
  end if;

  select requires_location, redemption_locations
    into v_requires, v_locations
  from public.ticket_templates
  where id = new.ticket_template_id;

  if found then
    new.requires_location := coalesce(v_requires,false);
    new.redemption_locations := case when coalesce(v_requires,false) then coalesce(v_locations,'[]'::jsonb) else '[]'::jsonb end;
  end if;
  return new;
end;
$$;

drop trigger if exists point_tickets_apply_location_rule on public.point_tickets;
create trigger point_tickets_apply_location_rule
before insert on public.point_tickets
for each row
execute function public.apply_point_ticket_location_rule();

create or replace function public.redeem_point_ticket_with_location(
  p_line_user_id text,
  p_ticket_id text,
  p_location jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $$
declare
  v_member_id uuid;
  v_ticket public.point_tickets%rowtype;
begin
  select id into v_member_id
  from public.members
  where line_user_id = p_line_user_id
    and membership_status = 'active'
    and status = 'active';

  if found then
    select * into v_ticket
    from public.point_tickets
    where ticket_id = p_ticket_id
      and member_id = v_member_id;

    if found and v_ticket.status = 'available' and v_ticket.requires_location then
      perform public.verify_ticket_redemption_locations(v_ticket.redemption_locations,p_location);
    end if;
  end if;

  return public.redeem_point_ticket(p_line_user_id,p_ticket_id);
end;
$$;

create or replace function public.redeem_point_tickets_with_location(
  p_line_user_id text,
  p_ticket_ids text[],
  p_request_id text,
  p_location jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = 'public','pg_temp'
as $$
declare
  v_member_id uuid;
  v_ticket public.point_tickets%rowtype;
  v_already_applied boolean := false;
begin
  select id into v_member_id
  from public.members
  where line_user_id = p_line_user_id
    and membership_status = 'active'
    and status = 'active';

  if found then
    select exists(
      select 1
      from public.audit_logs
      where actor_line_user_id = p_line_user_id
        and action = 'user.pointcard.tickets.redeem'
        and target_type = 'point_ticket_batch'
        and target_id = p_request_id
        and result = 'success'
    ) into v_already_applied;

    if not v_already_applied then
      for v_ticket in
        select *
        from public.point_tickets
        where member_id = v_member_id
          and ticket_id = any(p_ticket_ids)
          and status = 'available'
        order by ticket_id
      loop
        if v_ticket.requires_location then
          perform public.verify_ticket_redemption_locations(v_ticket.redemption_locations,p_location);
        end if;
      end loop;
    end if;
  end if;

  return public.redeem_point_tickets(p_line_user_id,p_ticket_ids,p_request_id);
end;
$$;

revoke all on function public.redeem_point_ticket_with_location(text,text,jsonb) from public, anon, authenticated;
revoke all on function public.redeem_point_tickets_with_location(text,text[],text,jsonb) from public, anon, authenticated;
grant execute on function public.redeem_point_ticket_with_location(text,text,jsonb) to service_role;
grant execute on function public.redeem_point_tickets_with_location(text,text[],text,jsonb) to service_role;
