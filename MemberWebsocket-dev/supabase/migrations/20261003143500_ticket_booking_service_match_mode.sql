alter table public.event_tickets
  add column if not exists required_service_match_mode text not null default 'any';

alter table public.point_card_rewards
  add column if not exists required_service_match_mode text not null default 'any';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.event_tickets'::regclass
      and conname = 'event_tickets_required_service_match_mode_check'
  ) then
    alter table public.event_tickets
      add constraint event_tickets_required_service_match_mode_check
      check (required_service_match_mode in ('any', 'all'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.point_card_rewards'::regclass
      and conname = 'point_card_rewards_required_service_match_mode_check'
  ) then
    alter table public.point_card_rewards
      add constraint point_card_rewards_required_service_match_mode_check
      check (required_service_match_mode in ('any', 'all'));
  end if;
end
$$;

create or replace function public.booking_meets_required_services(
  p_booking_id uuid,
  p_required_service_ids uuid[],
  p_match_mode text
)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  with booked_services as (
    select bi.service_id
    from public.booking_items bi
    where bi.booking_id = p_booking_id and bi.service_id is not null
    union
    select bpi.service_id
    from public.booking_participants bp
    join public.booking_participant_items bpi on bpi.participant_id = bp.id
    where bp.booking_id = p_booking_id and bpi.service_id is not null
  ),
  required_services as (
    select distinct service_id
    from unnest(coalesce(p_required_service_ids, '{}'::uuid[])) required(service_id)
  )
  select case
    when not exists (select 1 from required_services) then true
    when coalesce(p_match_mode, 'any') = 'all' then
      not exists (
        select 1 from required_services r
        where not exists (
          select 1 from booked_services b where b.service_id = r.service_id
        )
      )
    else
      exists (
        select 1
        from required_services r
        join booked_services b on b.service_id = r.service_id
      )
  end;
$$;

create or replace function public.validate_booking_benefit_service_requirement_row()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_required uuid[] := '{}'::uuid[];
  v_match_mode text := 'any';
  v_titles text[] := '{}'::text[];
begin
  if new.status = 'cancelled' or new.benefit_kind = 'calendar' then
    return new;
  end if;

  if new.benefit_kind = 'points' then
    select coalesce(r.required_service_ids, '{}'::uuid[]),
           coalesce(r.required_service_match_mode, 'any')
      into v_required, v_match_mode
    from public.point_tickets pt
    join public.point_card_rewards r on r.id = pt.reward_id
    where pt.ticket_id = new.benefit_ref;
  elsif new.benefit_kind = 'event' then
    select coalesce(et.required_service_ids, '{}'::uuid[]),
           coalesce(et.required_service_match_mode, 'any')
      into v_required, v_match_mode
    from public.event_ticket_claims ec
    join public.event_tickets et on et.id = ec.event_ticket_id
    where ec.claim_id = new.benefit_ref;
  end if;

  v_required := coalesce(v_required, '{}'::uuid[]);
  v_match_mode := case when v_match_mode = 'all' then 'all' else 'any' end;

  if cardinality(v_required) > 0
     and not public.booking_meets_required_services(new.booking_id, v_required, v_match_mode) then
    v_titles := public.required_booking_service_titles(v_required);
    raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'
      using detail = format(
        case when v_match_mode = 'all'
          then '票券「%s」需預約所有指定項目：%s'
          else '票券「%s」需預約以下任一項目：%s'
        end,
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
  v_match_mode text;
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
    v_match_mode := 'any';

    if v_selection.benefit_kind = 'points' then
      select coalesce(r.required_service_ids, '{}'::uuid[]),
             coalesce(r.required_service_match_mode, 'any')
        into v_required, v_match_mode
      from public.point_tickets pt
      join public.point_card_rewards r on r.id = pt.reward_id
      where pt.ticket_id = v_selection.benefit_ref;
    else
      select coalesce(et.required_service_ids, '{}'::uuid[]),
             coalesce(et.required_service_match_mode, 'any')
        into v_required, v_match_mode
      from public.event_ticket_claims ec
      join public.event_tickets et on et.id = ec.event_ticket_id
      where ec.claim_id = v_selection.benefit_ref;
    end if;

    v_required := coalesce(v_required, '{}'::uuid[]);
    v_match_mode := case when v_match_mode = 'all' then 'all' else 'any' end;

    if cardinality(v_required) > 0
       and not public.booking_meets_required_services(new.id, v_required, v_match_mode) then
      v_titles := public.required_booking_service_titles(v_required);
      raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'
        using detail = format(
          case when v_match_mode = 'all'
            then '票券「%s」需預約所有指定項目：%s'
            else '票券「%s」需預約以下任一項目：%s'
          end,
          coalesce(nullif(v_selection.title_snapshot, ''), v_selection.benefit_ref),
          array_to_string(v_titles, '、')
        );
    end if;
  end loop;
  return new;
end;
$$;

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
  v_required_service_match_mode text := 'any';
  v_requested_count integer := 0;
begin
  v_card_id := public.save_point_card(p_actor_line_user_id, p_card, p_expected_updated_at);

  select id into v_card_uuid
  from public.point_cards
  where card_id = v_card_id;

  if v_card_uuid is null then
    raise exception 'POINT_CARD_NOT_FOUND';
  end if;

  if jsonb_typeof(p_card->'rewards') = 'array' then
    for v_reward in select value from jsonb_array_elements(p_card->'rewards')
    loop
      begin
        v_threshold := (v_reward->>'thresholdStamps')::integer;
      exception when others then
        raise exception 'INVALID_REWARD_THRESHOLD';
      end;

      v_required_service_ids := '{}'::uuid[];
      v_required_service_match_mode := case
        when lower(btrim(coalesce(v_reward->>'requiredServiceMatchMode', 'any'))) = 'all' then 'all'
        else 'any'
      end;
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
      where point_card_id = v_card_uuid and threshold_stamps = v_threshold
      limit 1;

      if v_reward_id is null then
        raise exception 'INVALID_REWARD_THRESHOLD';
      end if;

      update public.point_card_rewards
      set required_service_ids = v_required_service_ids,
          required_service_match_mode = v_required_service_match_mode,
          updated_at = now()
      where id = v_reward_id;
    end loop;
  end if;

  return v_card_id;
end;
$$;

revoke all on function public.booking_meets_required_services(uuid, uuid[], text)
  from public, anon, authenticated;
revoke all on function public.save_point_card_service_items(text, jsonb, timestamp with time zone)
  from public, anon, authenticated;
grant execute on function public.save_point_card_service_items(text, jsonb, timestamp with time zone)
  to service_role;

comment on column public.event_tickets.required_service_match_mode is
  'How required_service_ids are matched: any = at least one selected service is booked; all = every selected service is booked.';
comment on column public.point_card_rewards.required_service_match_mode is
  'How required_service_ids are matched: any = at least one selected service is booked; all = every selected service is booked.';
