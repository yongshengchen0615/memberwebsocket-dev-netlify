alter table public.event_tickets
  add column if not exists required_service_ids uuid[] not null default '{}'::uuid[];

alter table public.point_card_rewards
  add column if not exists required_service_ids uuid[] not null default '{}'::uuid[];

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.event_tickets'::regclass
      and conname = 'event_tickets_required_service_ids_limit_check'
  ) then
    alter table public.event_tickets
      add constraint event_tickets_required_service_ids_limit_check
      check (cardinality(required_service_ids) <= 20);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.point_card_rewards'::regclass
      and conname = 'point_card_rewards_required_service_ids_limit_check'
  ) then
    alter table public.point_card_rewards
      add constraint point_card_rewards_required_service_ids_limit_check
      check (cardinality(required_service_ids) <= 20);
  end if;
end
$$;

-- Compatibility: old type-based rules become all current concrete services in that type.
-- New writes use required_service_ids directly, so future rules are item-specific.
update public.event_tickets et
set required_service_ids = coalesce((
  select array_agg(bs.id order by bs.created_at, bs.id)
  from public.booking_services bs
  where bs.deleted_at is null
    and exists (
      select 1
      from unnest(et.required_service_types) as required(service_type)
      where lower(btrim(required.service_type)) = lower(btrim(bs.service_type))
    )
), '{}'::uuid[])
where coalesce(cardinality(et.required_service_types), 0) > 0
  and coalesce(cardinality(et.required_service_ids), 0) = 0;

update public.point_card_rewards r
set required_service_ids = coalesce((
  select array_agg(bs.id order by bs.created_at, bs.id)
  from public.booking_services bs
  where bs.deleted_at is null
    and exists (
      select 1
      from unnest(r.required_service_types) as required(service_type)
      where lower(btrim(required.service_type)) = lower(btrim(bs.service_type))
    )
), '{}'::uuid[]),
    updated_at = now()
where coalesce(cardinality(r.required_service_types), 0) > 0
  and coalesce(cardinality(r.required_service_ids), 0) = 0;

-- During rolling deployment, legacy clients can still send required_service_types.
-- Translate those values to concrete service IDs until every client is on the new contract.
create or replace function public.sync_legacy_ticket_required_service_types_to_ids()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.required_service_ids := coalesce((
    select array_agg(bs.id order by bs.created_at, bs.id)
    from public.booking_services bs
    where bs.deleted_at is null
      and exists (
        select 1
        from unnest(coalesce(new.required_service_types, '{}'::text[])) as required(service_type)
        where lower(btrim(required.service_type)) = lower(btrim(bs.service_type))
      )
  ), '{}'::uuid[]);
  return new;
end;
$$;

drop trigger if exists sync_event_ticket_required_service_types_to_ids
  on public.event_tickets;
create trigger sync_event_ticket_required_service_types_to_ids
before insert or update of required_service_types
on public.event_tickets
for each row
execute function public.sync_legacy_ticket_required_service_types_to_ids();

drop trigger if exists sync_point_reward_required_service_types_to_ids
  on public.point_card_rewards;
create trigger sync_point_reward_required_service_types_to_ids
before insert or update of required_service_types
on public.point_card_rewards
for each row
execute function public.sync_legacy_ticket_required_service_types_to_ids();

create or replace function public.validate_ticket_required_service_ids()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from unnest(coalesce(new.required_service_ids, '{}'::uuid[])) as required(service_id)
    left join public.booking_services bs on bs.id = required.service_id
    where bs.id is null
  ) then
    raise exception 'INVALID_REQUIRED_SERVICE_IDS';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_event_ticket_required_service_ids
  on public.event_tickets;
create trigger validate_event_ticket_required_service_ids
before insert or update of required_service_ids
on public.event_tickets
for each row
execute function public.validate_ticket_required_service_ids();

drop trigger if exists validate_point_reward_required_service_ids
  on public.point_card_rewards;
create trigger validate_point_reward_required_service_ids
before insert or update of required_service_ids
on public.point_card_rewards
for each row
execute function public.validate_ticket_required_service_ids();

create or replace function public.booking_has_required_service_id(
  p_booking_id uuid,
  p_required_service_ids uuid[]
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select
    coalesce(cardinality(p_required_service_ids), 0) = 0
    or exists (
      select 1
      from public.booking_items bi
      where bi.booking_id = p_booking_id
        and bi.service_id = any(p_required_service_ids)
    )
    or exists (
      select 1
      from public.booking_participants bp
      join public.booking_participant_items bpi on bpi.participant_id = bp.id
      where bp.booking_id = p_booking_id
        and bpi.service_id = any(p_required_service_ids)
    );
$$;

create or replace function public.required_booking_service_titles(
  p_required_service_ids uuid[]
)
returns text[]
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    array_agg(bs.title order by array_position(p_required_service_ids, bs.id)),
    '{}'::text[]
  )
  from public.booking_services bs
  where bs.id = any(coalesce(p_required_service_ids, '{}'::uuid[]));
$$;

create or replace function public.validate_booking_benefit_service_requirement_row()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_required uuid[] := '{}'::uuid[];
  v_titles text[] := '{}'::text[];
begin
  if new.status = 'cancelled' or new.benefit_kind = 'calendar' then
    return new;
  end if;

  if new.benefit_kind = 'points' then
    select coalesce(r.required_service_ids, '{}'::uuid[])
      into v_required
    from public.point_tickets pt
    join public.point_card_rewards r on r.id = pt.reward_id
    where pt.ticket_id = new.benefit_ref;
  elsif new.benefit_kind = 'event' then
    select coalesce(et.required_service_ids, '{}'::uuid[])
      into v_required
    from public.event_ticket_claims ec
    join public.event_tickets et on et.id = ec.event_ticket_id
    where ec.claim_id = new.benefit_ref;
  end if;

  v_required := coalesce(v_required, '{}'::uuid[]);
  if cardinality(v_required) > 0
     and not public.booking_has_required_service_id(new.booking_id, v_required) then
    v_titles := public.required_booking_service_titles(v_required);
    raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'
      using detail = format(
        '票券「%s」需預約以下任一項目：%s',
        coalesce(nullif(new.title_snapshot, ''), new.benefit_ref),
        array_to_string(v_titles, '、')
      );
  end if;

  return new;
end;
$$;

create or replace function public.validate_booking_service_requirements_on_completion()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_selection record;
  v_required uuid[];
  v_titles text[];
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
    v_required := '{}'::uuid[];

    if v_selection.benefit_kind = 'points' then
      select coalesce(r.required_service_ids, '{}'::uuid[])
        into v_required
      from public.point_tickets pt
      join public.point_card_rewards r on r.id = pt.reward_id
      where pt.ticket_id = v_selection.benefit_ref;
    else
      select coalesce(et.required_service_ids, '{}'::uuid[])
        into v_required
      from public.event_ticket_claims ec
      join public.event_tickets et on et.id = ec.event_ticket_id
      where ec.claim_id = v_selection.benefit_ref;
    end if;

    v_required := coalesce(v_required, '{}'::uuid[]);
    if cardinality(v_required) > 0
       and not public.booking_has_required_service_id(new.id, v_required) then
      v_titles := public.required_booking_service_titles(v_required);
      raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'
        using detail = format(
          '票券「%s」需預約以下任一項目：%s',
          coalesce(nullif(v_selection.title_snapshot, ''), v_selection.benefit_ref),
          array_to_string(v_titles, '、')
        );
    end if;
  end loop;

  return new;
end;
$$;

create or replace function public.prevent_delete_ticket_required_service_item()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.event_tickets et
    where old.id = any(coalesce(et.required_service_ids, '{}'::uuid[]))
  ) or exists (
    select 1 from public.point_card_rewards r
    where old.id = any(coalesce(r.required_service_ids, '{}'::uuid[]))
  ) then
    raise exception 'BOOKING_SERVICE_IN_USE';
  end if;
  return old;
end;
$$;

drop trigger if exists prevent_delete_ticket_required_service_item_trigger
  on public.booking_services;
create trigger prevent_delete_ticket_required_service_item_trigger
before delete on public.booking_services
for each row
execute function public.prevent_delete_ticket_required_service_item();

drop trigger if exists sync_ticket_required_service_type_name_trigger
  on public.booking_service_types;
drop trigger if exists prevent_delete_ticket_required_service_type_trigger
  on public.booking_service_types;

create or replace function public.save_point_card_service_items(
  p_actor_line_user_id text,
  p_card jsonb,
  p_expected_updated_at timestamp with time zone
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card_id text;
  v_card_uuid uuid;
  v_reward jsonb;
  v_threshold integer;
  v_reward_id uuid;
  v_required_service_ids uuid[] := '{}'::uuid[];
  v_requested_count integer := 0;
begin
  v_card_id := public.save_point_card(
    p_actor_line_user_id,
    p_card,
    p_expected_updated_at
  );

  select id into v_card_uuid
  from public.point_cards
  where card_id = v_card_id;

  if v_card_uuid is null then
    raise exception 'POINT_CARD_NOT_FOUND';
  end if;

  if jsonb_typeof(p_card->'rewards') = 'array' then
    for v_reward in
      select value from jsonb_array_elements(p_card->'rewards')
    loop
      begin
        v_threshold := (v_reward->>'thresholdStamps')::integer;
      exception when others then
        raise exception 'INVALID_REWARD_THRESHOLD';
      end;

      v_required_service_ids := '{}'::uuid[];
      v_requested_count := 0;

      if v_reward ? 'requiredServiceIds' and v_reward->'requiredServiceIds' is not null then
        if jsonb_typeof(v_reward->'requiredServiceIds') <> 'array'
           or jsonb_array_length(v_reward->'requiredServiceIds') > 20 then
          raise exception 'INVALID_REQUIRED_SERVICE_IDS';
        end if;

        select count(distinct btrim(value))
          into v_requested_count
        from jsonb_array_elements_text(v_reward->'requiredServiceIds')
        where btrim(value) <> '';

        select coalesce(array_agg(bs.id order by bs.created_at, bs.id), '{}'::uuid[])
          into v_required_service_ids
        from public.booking_services bs
        where bs.deleted_at is null
          and exists (
            select 1
            from jsonb_array_elements_text(v_reward->'requiredServiceIds') requested(value)
            where btrim(requested.value) = bs.id::text
          );

        if cardinality(v_required_service_ids) <> v_requested_count then
          raise exception 'INVALID_REQUIRED_SERVICE_IDS';
        end if;
      end if;

      select id into v_reward_id
      from public.point_card_rewards
      where point_card_id = v_card_uuid
        and threshold_stamps = v_threshold
      limit 1;

      if v_reward_id is null then
        raise exception 'INVALID_REWARD_THRESHOLD';
      end if;

      update public.point_card_rewards
      set required_service_ids = v_required_service_ids,
          updated_at = now()
      where id = v_reward_id;
    end loop;
  end if;

  return v_card_id;
end;
$$;

revoke all on function public.booking_has_required_service_id(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.required_booking_service_titles(uuid[]) from public, anon, authenticated;
revoke all on function public.sync_legacy_ticket_required_service_types_to_ids() from public, anon, authenticated;
revoke all on function public.validate_ticket_required_service_ids() from public, anon, authenticated;
revoke all on function public.validate_booking_benefit_service_requirement_row() from public, anon, authenticated;
revoke all on function public.validate_booking_service_requirements_on_completion() from public, anon, authenticated;
revoke all on function public.prevent_delete_ticket_required_service_item() from public, anon, authenticated;
revoke all on function public.save_point_card_service_items(text, jsonb, timestamp with time zone) from public, anon, authenticated;
grant execute on function public.save_point_card_service_items(text, jsonb, timestamp with time zone) to service_role;

comment on column public.event_tickets.required_service_ids is
  'Concrete booking_services.id values required to use this event ticket. Empty array means unrestricted; any one matching service is sufficient.';
comment on column public.point_card_rewards.required_service_ids is
  'Concrete booking_services.id values required to use this point-card reward. Empty array means unrestricted; any one matching service is sufficient.';
