alter table public.ticket_templates
  add column if not exists required_service_types text[] not null default '{}'::text[];

alter table public.event_tickets
  add column if not exists required_service_types text[] not null default '{}'::text[];

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ticket_templates'::regclass
      and conname = 'ticket_templates_required_service_types_limit_check'
  ) then
    alter table public.ticket_templates
      add constraint ticket_templates_required_service_types_limit_check
      check (cardinality(required_service_types) <= 20);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.event_tickets'::regclass
      and conname = 'event_tickets_required_service_types_limit_check'
  ) then
    alter table public.event_tickets
      add constraint event_tickets_required_service_types_limit_check
      check (cardinality(required_service_types) <= 20);
  end if;
end
$$;

create or replace function public.booking_has_required_service_type(
  p_booking_id uuid,
  p_required_service_types text[]
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  with booking_service_types as (
    select coalesce(
      nullif(btrim(bi.service_type), ''),
      nullif(btrim(bs.service_type), '')
    ) as service_type
    from public.booking_items bi
    left join public.booking_services bs on bs.id = bi.service_id
    where bi.booking_id = p_booking_id
    union
    select nullif(btrim(bs.service_type), '') as service_type
    from public.booking_participants bp
    join public.booking_participant_items bpi on bpi.participant_id = bp.id
    join public.booking_services bs on bs.id = bpi.service_id
    where bp.booking_id = p_booking_id
  )
  select
    coalesce(cardinality(p_required_service_types), 0) = 0
    or exists (
      select 1
      from booking_service_types bst
      cross join unnest(p_required_service_types) as required(service_type)
      where bst.service_type is not null
        and lower(btrim(bst.service_type)) = lower(btrim(required.service_type))
    );
$$;

create or replace function public.validate_booking_benefit_service_requirement_row()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_required text[] := '{}'::text[];
begin
  if new.status = 'cancelled' or new.benefit_kind = 'calendar' then
    return new;
  end if;
  if new.benefit_kind = 'points' then
    select coalesce(tt.required_service_types, '{}'::text[])
      into v_required
    from public.point_tickets pt
    join public.ticket_templates tt on tt.id = pt.ticket_template_id
    where pt.ticket_id = new.benefit_ref;
  elsif new.benefit_kind = 'event' then
    select coalesce(et.required_service_types, '{}'::text[])
      into v_required
    from public.event_ticket_claims ec
    join public.event_tickets et on et.id = ec.event_ticket_id
    where ec.claim_id = new.benefit_ref;
  end if;
  v_required := coalesce(v_required, '{}'::text[]);
  if cardinality(v_required) > 0
     and not public.booking_has_required_service_type(new.booking_id, v_required) then
    raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'
      using detail = format(
        '票券「%s」需預約以下任一項目類型：%s',
        coalesce(nullif(new.title_snapshot, ''), new.benefit_ref),
        array_to_string(v_required, '、')
      );
  end if;
  return new;
end;
$$;

drop trigger if exists booking_benefit_service_requirement_guard
  on public.booking_benefit_selections;
create trigger booking_benefit_service_requirement_guard
before insert or update of booking_id, benefit_kind, benefit_ref, status
on public.booking_benefit_selections
for each row
execute function public.validate_booking_benefit_service_requirement_row();

create or replace function public.validate_booking_service_requirements_on_completion()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_selection record;
  v_required text[];
begin
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;
  for v_selection in
    select benefit_kind, benefit_ref, title_snapshot
    from public.booking_benefit_selections
    where booking_id = new.id
      and status in ('pending', 'redeemed', 'applied')
      and benefit_kind in ('points', 'event')
  loop
    v_required := '{}'::text[];
    if v_selection.benefit_kind = 'points' then
      select coalesce(tt.required_service_types, '{}'::text[])
        into v_required
      from public.point_tickets pt
      join public.ticket_templates tt on tt.id = pt.ticket_template_id
      where pt.ticket_id = v_selection.benefit_ref;
    else
      select coalesce(et.required_service_types, '{}'::text[])
        into v_required
      from public.event_ticket_claims ec
      join public.event_tickets et on et.id = ec.event_ticket_id
      where ec.claim_id = v_selection.benefit_ref;
    end if;
    v_required := coalesce(v_required, '{}'::text[]);
    if cardinality(v_required) > 0
       and not public.booking_has_required_service_type(new.id, v_required) then
      raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'
        using detail = format(
          '票券「%s」需預約以下任一項目類型：%s',
          coalesce(nullif(v_selection.title_snapshot, ''), v_selection.benefit_ref),
          array_to_string(v_required, '、')
        );
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists booking_completion_service_requirement_guard
  on public.bookings;
create trigger booking_completion_service_requirement_guard
before update of status on public.bookings
for each row
execute function public.validate_booking_service_requirements_on_completion();

revoke all on function public.booking_has_required_service_type(uuid, text[]) from public, anon, authenticated;
revoke all on function public.validate_booking_benefit_service_requirement_row() from public, anon, authenticated;
revoke all on function public.validate_booking_service_requirements_on_completion() from public, anon, authenticated;

comment on column public.ticket_templates.required_service_types is
  'Booking service type names required to use this point-card ticket. Empty array means unrestricted; any one matching type is sufficient.';
comment on column public.event_tickets.required_service_types is
  'Booking service type names required to use this event ticket. Empty array means unrestricted; any one matching type is sufficient.';
