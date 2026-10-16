create table public.booking_service_type_rewards (
  service_type_id uuid primary key references public.booking_service_types(id) on delete cascade,
  point_card_id uuid not null references public.point_cards(id) on delete cascade,
  minutes_per_point integer not null check (minutes_per_point between 1 and 10080),
  created_by text not null default 'system',
  updated_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index booking_service_type_rewards_point_card_idx
  on public.booking_service_type_rewards(point_card_id);

alter table public.booking_service_type_rewards enable row level security;
revoke all on table public.booking_service_type_rewards from anon, authenticated;

create table public.booking_completion_settlements (
  booking_id uuid primary key references public.bookings(id) on delete restrict,
  member_id uuid not null references public.members(id) on delete restrict,
  service_minutes integer not null check (service_minutes >= 0),
  reward_details jsonb not null default '[]'::jsonb check (jsonb_typeof(reward_details) = 'array'),
  completed_by text not null,
  created_at timestamptz not null default now()
);

create index booking_completion_settlements_member_created_idx
  on public.booking_completion_settlements(member_id, created_at desc);

alter table public.booking_completion_settlements enable row level security;
revoke all on table public.booking_completion_settlements from anon, authenticated;

alter table public.service_time_entries
  drop constraint if exists service_time_entries_minutes_check;

alter table public.service_time_entries
  add constraint service_time_entries_minutes_check
  check (minutes >= 1);

create or replace function public.save_booking_service_type(
  p_type_id uuid,
  p_name text,
  p_reward_minutes_per_point integer default null,
  p_reward_point_card_id uuid default null,
  p_actor text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_type_id uuid;
  v_old_name text;
  v_name text := btrim(coalesce(p_name, ''));
  v_actor text := coalesce(nullif(btrim(coalesce(p_actor, '')), ''), 'system');
  v_sort_order integer;
  v_card public.point_cards%rowtype;
begin
  if char_length(v_name) not between 1 and 80 then
    raise exception 'INVALID_SERVICE_TYPE_NAME';
  end if;

  if (p_reward_minutes_per_point is null) <> (p_reward_point_card_id is null) then
    raise exception 'INVALID_BOOKING_REWARD_RULE';
  end if;

  if p_reward_minutes_per_point is not null
     and (p_reward_minutes_per_point < 1 or p_reward_minutes_per_point > 10080) then
    raise exception 'INVALID_BOOKING_REWARD_MINUTES';
  end if;

  if p_reward_point_card_id is not null then
    select * into v_card
    from public.point_cards
    where id = p_reward_point_card_id
    for update;

    if not found
       or v_card.status <> 'active'
       or (v_card.expiry_mode <> 'unlimited'
           and (v_card.expires_on is null
                or v_card.expires_on < (clock_timestamp() at time zone 'Asia/Taipei')::date)) then
      raise exception 'BOOKING_REWARD_POINT_CARD_UNAVAILABLE';
    end if;
  end if;

  if p_type_id is null then
    if exists (
      select 1 from public.booking_service_types
      where lower(btrim(name)) = lower(v_name)
    ) then
      raise exception 'DUPLICATE_SERVICE_TYPE';
    end if;

    select coalesce(max(sort_order), -1) + 1
      into v_sort_order
    from public.booking_service_types;

    insert into public.booking_service_types(name, sort_order)
    values (v_name, least(1000, v_sort_order))
    returning id into v_type_id;
  else
    select name into v_old_name
    from public.booking_service_types
    where id = p_type_id
    for update;

    if not found then
      raise exception 'BOOKING_SERVICE_TYPE_NOT_FOUND';
    end if;

    if exists (
      select 1 from public.booking_service_types
      where id <> p_type_id
        and lower(btrim(name)) = lower(v_name)
    ) then
      raise exception 'DUPLICATE_SERVICE_TYPE';
    end if;

    update public.booking_service_types
    set name = v_name,
        updated_at = now()
    where id = p_type_id;

    if lower(btrim(v_old_name)) <> lower(v_name) then
      update public.booking_services
      set service_type = v_name,
          description = '__TYPE__:' || v_name
      where coalesce(counts_toward_membership, true) = true
        and lower(btrim(coalesce(service_type, ''))) = lower(btrim(v_old_name));

      update public.booking_items bi
      set service_type = v_name
      from public.bookings b
      where b.id = bi.booking_id
        and b.status in ('pending', 'confirmed')
        and lower(btrim(coalesce(bi.service_type, ''))) = lower(btrim(v_old_name));

      update public.booking_participant_items bpi
      set service_type = v_name
      from public.booking_participants bp
      join public.bookings b on b.id = bp.booking_id
      where bpi.participant_id = bp.id
        and b.status in ('pending', 'confirmed')
        and lower(btrim(coalesce(bpi.service_type, ''))) = lower(btrim(v_old_name));
    end if;

    v_type_id := p_type_id;
  end if;

  if p_reward_minutes_per_point is null then
    delete from public.booking_service_type_rewards
    where service_type_id = v_type_id;
  else
    insert into public.booking_service_type_rewards(
      service_type_id, point_card_id, minutes_per_point,
      created_by, updated_by, created_at, updated_at
    )
    values (
      v_type_id, p_reward_point_card_id, p_reward_minutes_per_point,
      v_actor, v_actor, now(), now()
    )
    on conflict (service_type_id) do update
    set point_card_id = excluded.point_card_id,
        minutes_per_point = excluded.minutes_per_point,
        updated_by = excluded.updated_by,
        updated_at = now();
  end if;

  return (
    select jsonb_build_object(
      'id', t.id,
      'name', t.name,
      'sortOrder', t.sort_order,
      'rewardMinutesPerPoint', r.minutes_per_point,
      'rewardPointCardId', r.point_card_id,
      'rewardPointCardTitle', c.title,
      'createdAt', t.created_at,
      'updatedAt', t.updated_at
    )
    from public.booking_service_types t
    left join public.booking_service_type_rewards r on r.service_type_id = t.id
    left join public.point_cards c on c.id = r.point_card_id
    where t.id = v_type_id
  );
end;
$function$;

create or replace function public.rename_booking_service_type(
  p_type_id uuid,
  p_name text,
  p_actor text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_minutes integer;
  v_card uuid;
begin
  select minutes_per_point, point_card_id
    into v_minutes, v_card
  from public.booking_service_type_rewards
  where service_type_id = p_type_id;

  perform public.save_booking_service_type(
    p_type_id,
    p_name,
    v_minutes,
    v_card,
    p_actor
  );
end;
$function$;

create or replace function public.complete_booking_with_rewards_request(
  p_booking_id uuid,
  p_expected_updated_at timestamptz,
  p_actor text,
  p_admin_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_booking public.bookings%rowtype;
  v_request_id text := 'booking-complete:' || p_booking_id::text;
  v_service_minutes integer := 0;
  v_reward_details jsonb := '[]'::jsonb;
  v_reward record;
  v_card public.point_cards%rowtype;
  v_rows integer := 0;
  v_now timestamptz := now();
begin
  select * into v_booking
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;

  if p_expected_updated_at is null or v_booking.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_CONFLICT';
  end if;

  if v_booking.cancellation_requested_at is not null
     and v_booking.cancellation_reviewed_at is null then
    raise exception 'BOOKING_CANCELLATION_PENDING';
  end if;

  if v_booking.status <> 'confirmed' then
    raise exception 'INVALID_BOOKING_TRANSITION';
  end if;

  if exists (
    select 1
    from public.booking_completion_settlements
    where booking_id = p_booking_id
  ) then
    raise exception 'BOOKING_COMPLETION_ALREADY_SETTLED';
  end if;

  select coalesce(sum(bi.unit_duration_minutes * greatest(coalesce(bi.quantity, 1), 1)), 0)::integer
    into v_service_minutes
  from public.booking_items bi
  where bi.booking_id = p_booking_id
    and bi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid
    and coalesce(bi.counts_toward_membership, true) = true;

  for v_reward in
    with type_minutes as (
      select
        lower(btrim(coalesce(bi.service_type, ''))) as type_key,
        sum(bi.unit_duration_minutes * greatest(coalesce(bi.quantity, 1), 1))::integer as service_minutes
      from public.booking_items bi
      where bi.booking_id = p_booking_id
        and bi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid
        and coalesce(bi.counts_toward_membership, true) = true
        and nullif(btrim(coalesce(bi.service_type, '')), '') is not null
      group by lower(btrim(coalesce(bi.service_type, '')))
    )
    select
      t.id as service_type_id,
      t.name as service_type_name,
      tm.service_minutes,
      r.minutes_per_point,
      r.point_card_id,
      floor(tm.service_minutes::numeric / r.minutes_per_point)::integer as points
    from type_minutes tm
    join public.booking_service_types t
      on lower(btrim(t.name)) = tm.type_key
    join public.booking_service_type_rewards r
      on r.service_type_id = t.id
    where floor(tm.service_minutes::numeric / r.minutes_per_point)::integer > 0
    order by t.sort_order, t.created_at
  loop
    select * into v_card
    from public.point_cards
    where id = v_reward.point_card_id
    for update;

    if not found
       or v_card.status <> 'active'
       or (v_card.expiry_mode <> 'unlimited'
           and (v_card.expires_on is null
                or v_card.expires_on < (clock_timestamp() at time zone 'Asia/Taipei')::date)) then
      raise exception 'BOOKING_REWARD_POINT_CARD_UNAVAILABLE';
    end if;

    v_reward_details := v_reward_details || jsonb_build_array(
      jsonb_build_object(
        'serviceTypeId', v_reward.service_type_id,
        'serviceTypeName', v_reward.service_type_name,
        'serviceMinutes', v_reward.service_minutes,
        'minutesPerPoint', v_reward.minutes_per_point,
        'pointCardId', v_card.id,
        'pointCardPublicId', v_card.card_id,
        'pointCardTitle', v_card.title,
        'points', v_reward.points
      )
    );
  end loop;

  if v_service_minutes > 0 then
    insert into public.service_time_entries(
      entry_id, member_id, minutes, note, created_by, request_id
    )
    values (
      public.new_public_id('SE'),
      v_booking.member_id,
      v_service_minutes,
      '預約完成自動加入服務時間',
      p_actor,
      v_request_id
    )
    on conflict (request_id, member_id)
      where request_id is not null and request_id <> ''
    do nothing;

    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'BOOKING_COMPLETION_SERVICE_TIME_CONFLICT';
    end if;
  end if;

  for v_reward in
    with type_minutes as (
      select
        lower(btrim(coalesce(bi.service_type, ''))) as type_key,
        sum(bi.unit_duration_minutes * greatest(coalesce(bi.quantity, 1), 1))::integer as service_minutes
      from public.booking_items bi
      where bi.booking_id = p_booking_id
        and bi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid
        and coalesce(bi.counts_toward_membership, true) = true
        and nullif(btrim(coalesce(bi.service_type, '')), '') is not null
      group by lower(btrim(coalesce(bi.service_type, '')))
    ),
    per_type as (
      select
        r.point_card_id,
        floor(tm.service_minutes::numeric / r.minutes_per_point)::integer as points
      from type_minutes tm
      join public.booking_service_types t
        on lower(btrim(t.name)) = tm.type_key
      join public.booking_service_type_rewards r
        on r.service_type_id = t.id
    )
    select point_card_id, sum(points)::integer as points
    from per_type
    where points > 0
    group by point_card_id
  loop
    insert into public.point_entries(
      entry_id, member_id, point_card_id, amount, note, created_by,
      request_id, entry_type, reference_type, reference_id
    )
    values (
      public.new_public_id('PE'),
      v_booking.member_id,
      v_reward.point_card_id,
      v_reward.points,
      '預約完成自動集點',
      p_actor,
      v_request_id,
      'grant',
      'booking',
      p_booking_id::text
    )
    on conflict (request_id, member_id, point_card_id)
      where request_id is not null and request_id <> ''
    do nothing;

    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'BOOKING_COMPLETION_POINT_CONFLICT';
    end if;

    insert into public.point_balances(member_id, point_card_id, stamps, updated_at)
    values (v_booking.member_id, v_reward.point_card_id, v_reward.points, v_now)
    on conflict (member_id, point_card_id)
    do update
      set stamps = public.point_balances.stamps + excluded.stamps,
          updated_at = v_now;

    perform public.issue_eligible_point_tickets(v_booking.member_id, v_reward.point_card_id);
  end loop;

  insert into public.booking_completion_settlements(
    booking_id, member_id, service_minutes, reward_details, completed_by, created_at
  )
  values (
    p_booking_id,
    v_booking.member_id,
    v_service_minutes,
    v_reward_details,
    p_actor,
    v_now
  );

  update public.bookings
  set status = 'completed',
      admin_note = left(coalesce(p_admin_note, ''), 500),
      completed_by = p_actor,
      completed_at = v_now
  where id = p_booking_id
    and status = 'confirmed'
    and updated_at = p_expected_updated_at;

  if not found then
    raise exception 'BOOKING_CONFLICT';
  end if;

  return jsonb_build_object(
    'bookingId', p_booking_id,
    'serviceMinutes', v_service_minutes,
    'rewards', v_reward_details
  );
end;
$function$;

revoke all on function public.save_booking_service_type(uuid,text,integer,uuid,text) from public, anon, authenticated;
grant execute on function public.save_booking_service_type(uuid,text,integer,uuid,text) to service_role;

revoke all on function public.complete_booking_with_rewards_request(uuid,timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.complete_booking_with_rewards_request(uuid,timestamptz,text,text) to service_role;

revoke all on function public.rename_booking_service_type(uuid,text,text) from public, anon, authenticated;
grant execute on function public.rename_booking_service_type(uuid,text,text) to service_role;
