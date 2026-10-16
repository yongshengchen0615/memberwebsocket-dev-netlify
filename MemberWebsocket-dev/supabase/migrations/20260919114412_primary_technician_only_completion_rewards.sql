create or replace function public.complete_booking_with_rewards_request(
  p_booking_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_actor text,
  p_admin_note text default ''::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_booking public.bookings%rowtype;
  v_primary_technician_id uuid;
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

  select primary_technician_id
    into v_primary_technician_id
  from public.booking_settings
  where id = 1;

  if v_primary_technician_id is null then
    raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING';
  end if;

  if not exists (
    select 1
    from public.booking_participants bp
    where bp.booking_id = p_booking_id
      and bp.technician_id = v_primary_technician_id
  ) then
    raise exception 'BOOKING_PRIMARY_TECHNICIAN_REQUIRED';
  end if;

  with eligible_items as (
    select
      bpi.service_id,
      bpi.unit_duration_minutes,
      greatest(coalesce(bpi.quantity, 1), 1)::integer as quantity,
      coalesce(
        nullif(btrim(coalesce(bi.service_type, '')), ''),
        nullif(btrim(coalesce(bs.service_type, '')), '')
      ) as service_type,
      coalesce(bi.counts_toward_membership, bs.counts_toward_membership, true) as counts_toward_membership
    from public.booking_participants bp
    join public.booking_participant_items bpi
      on bpi.participant_id = bp.id
    left join public.booking_items bi
      on bi.booking_id = bp.booking_id
     and bi.service_id = bpi.service_id
    left join public.booking_services bs
      on bs.id = bpi.service_id
    where bp.booking_id = p_booking_id
      and bp.technician_id = v_primary_technician_id
      and bpi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid
  )
  select coalesce(sum(ei.unit_duration_minutes * ei.quantity), 0)::integer
    into v_service_minutes
  from eligible_items ei
  where ei.counts_toward_membership = true;

  for v_reward in
    with eligible_items as (
      select
        bpi.service_id,
        bpi.unit_duration_minutes,
        greatest(coalesce(bpi.quantity, 1), 1)::integer as quantity,
        coalesce(
          nullif(btrim(coalesce(bi.service_type, '')), ''),
          nullif(btrim(coalesce(bs.service_type, '')), '')
        ) as service_type,
        coalesce(bi.counts_toward_membership, bs.counts_toward_membership, true) as counts_toward_membership
      from public.booking_participants bp
      join public.booking_participant_items bpi
        on bpi.participant_id = bp.id
      left join public.booking_items bi
        on bi.booking_id = bp.booking_id
       and bi.service_id = bpi.service_id
      left join public.booking_services bs
        on bs.id = bpi.service_id
      where bp.booking_id = p_booking_id
        and bp.technician_id = v_primary_technician_id
        and bpi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid
    ),
    type_minutes as (
      select
        lower(btrim(ei.service_type)) as type_key,
        sum(ei.unit_duration_minutes * ei.quantity)::integer as service_minutes
      from eligible_items ei
      where ei.counts_toward_membership = true
        and nullif(btrim(coalesce(ei.service_type, '')), '') is not null
      group by lower(btrim(ei.service_type))
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
      '預約完成自動加入服務時間（僅主要技師項目）',
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
    with eligible_items as (
      select
        bpi.service_id,
        bpi.unit_duration_minutes,
        greatest(coalesce(bpi.quantity, 1), 1)::integer as quantity,
        coalesce(
          nullif(btrim(coalesce(bi.service_type, '')), ''),
          nullif(btrim(coalesce(bs.service_type, '')), '')
        ) as service_type,
        coalesce(bi.counts_toward_membership, bs.counts_toward_membership, true) as counts_toward_membership
      from public.booking_participants bp
      join public.booking_participant_items bpi
        on bpi.participant_id = bp.id
      left join public.booking_items bi
        on bi.booking_id = bp.booking_id
       and bi.service_id = bpi.service_id
      left join public.booking_services bs
        on bs.id = bpi.service_id
      where bp.booking_id = p_booking_id
        and bp.technician_id = v_primary_technician_id
        and bpi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid
    ),
    type_minutes as (
      select
        lower(btrim(ei.service_type)) as type_key,
        sum(ei.unit_duration_minutes * ei.quantity)::integer as service_minutes
      from eligible_items ei
      where ei.counts_toward_membership = true
        and nullif(btrim(coalesce(ei.service_type, '')), '') is not null
      group by lower(btrim(ei.service_type))
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
      '預約完成自動集點（僅主要技師項目）',
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
    'primaryTechnicianId', v_primary_technician_id,
    'serviceMinutes', v_service_minutes,
    'rewards', v_reward_details
  );
end;
$function$;
