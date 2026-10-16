begin;

-- Additive settings preserve existing required-technician and immediate-notification behavior.
alter table public.booking_settings add column require_primary_technician boolean not null default true;
alter table public.bookings alter column technician_id drop not null;
alter table public.fixed_ticket_templates add column notify_time time;
alter table public.fixed_ticket_templates add constraint fixed_ticket_notify_time_minutes check (notify_time is null or extract(second from notify_time) = 0);
alter table public.scheduled_grant_messages add column fixed_ticket_grant_id uuid references public.fixed_ticket_grants(id) on delete set null,
  add column notification_business_date date;
create index scheduled_grant_fixed_grant_idx on public.scheduled_grant_messages(fixed_ticket_grant_id) where fixed_ticket_grant_id is not null;

-- Link legacy queue rows without changing sent notifications or request/retry identifiers.
update public.scheduled_grant_messages q set fixed_ticket_grant_id=g.id,
  notification_business_date=(q.created_at at time zone 'Asia/Taipei')::date
from public.fixed_ticket_grants g join public.fixed_ticket_templates t on t.id=g.fixed_ticket_template_id
where q.request_id='FIXED-'||t.fixed_ticket_id||'-'||replace(g.cycle_key,':','-')||'-'||g.member_id::text;


CREATE OR REPLACE FUNCTION public.protect_booking_primary_technician_setting()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.require_primary_technician and old.primary_technician_id is not null and new.primary_technician_id is null then
    new.primary_technician_id := old.primary_technician_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.validate_group_booking_technicians(p_participants jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_settings public.booking_settings%rowtype;
  v_participant jsonb;
  v_technician_id uuid;
  v_technician public.booking_technicians%rowtype;
  v_selected uuid[] := array[]::uuid[];
  v_primary_selected boolean := false;
begin
  select * into v_settings from public.booking_settings where id = 1 for share;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  if v_settings.require_primary_technician then
    if v_settings.primary_technician_id is null then raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING'; end if;

  select * into v_technician
  from public.booking_technicians
  where id = v_settings.primary_technician_id
  for share;
  if not found or not v_technician.is_active then raise exception 'BOOKING_PRIMARY_TECHNICIAN_DISABLED'; end if;
  end if;

  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then
    raise exception 'INVALID_BOOKING_PARTICIPANTS';
  end if;

  for v_participant in select value from jsonb_array_elements(p_participants) loop
    if nullif(btrim(coalesce(v_participant->>'technicianId','')), '') is null then
      continue;
    end if;

    begin
      v_technician_id := (v_participant->>'technicianId')::uuid;
    exception when others then
      raise exception 'INVALID_BOOKING_TECHNICIAN';
    end;

    if v_technician_id = any(v_selected) then
      raise exception 'DUPLICATE_PARTICIPANT_TECHNICIAN';
    end if;
    v_selected := array_append(v_selected, v_technician_id);

    select * into v_technician
    from public.booking_technicians
    where id = v_technician_id
    for share;
    if not found then raise exception 'BOOKING_TECHNICIAN_NOT_FOUND'; end if;
    if not v_technician.is_active then raise exception 'BOOKING_TECHNICIAN_DISABLED'; end if;

    if v_technician_id = v_settings.primary_technician_id then
      v_primary_selected := true;
    end if;
  end loop;

  if v_settings.require_primary_technician and not v_primary_selected then
    raise exception 'BOOKING_PRIMARY_TECHNICIAN_REQUIRED';
  end if;

  return case when v_primary_selected then v_settings.primary_technician_id else v_selected[1] end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_group_booking_request(p_request_id text, p_member_id uuid, p_booking_date date, p_start_time time without time zone, p_technician_id uuid, p_participants jsonb, p_member_note text DEFAULT ''::text, p_contact_source text DEFAULT 'member'::text, p_contact_surname text DEFAULT NULL::text, p_contact_salutation text DEFAULT NULL::text, p_contact_phone text DEFAULT NULL::text)
 RETURNS bookings
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_settings public.booking_settings%rowtype;
  v_member public.members%rowtype;
  v_existing public.bookings%rowtype;
  v_booking public.bookings%rowtype;
  v_technician public.booking_technicians%rowtype;
  v_service public.booking_services%rowtype;
  v_store public.booking_services%rowtype;
  v_participant jsonb;
  v_item jsonb;
  v_participant_id uuid;
  v_service_id uuid;
  v_primary_service_id uuid;
  v_seen uuid[];
  v_quantity integer;
  v_party_size integer;
  v_position integer := 0;
  v_total_duration integer := 0;
  v_participant_duration integer := 0;
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_local_time time := (now() at time zone 'Asia/Taipei')::time;
  v_end_time time;
begin
  if p_request_id is null or char_length(btrim(p_request_id)) < 12 or char_length(p_request_id) > 100 then raise exception 'INVALID_REQUEST_ID'; end if;
  select * into v_existing from public.bookings where request_id = p_request_id;
  if found then
    if v_existing.member_id <> p_member_id then raise exception 'REQUEST_ID_CONFLICT'; end if;
    return v_existing;
  end if;

  select * into v_member from public.members where id = p_member_id;
  if not found then raise exception 'MEMBER_NOT_FOUND'; end if;
  if coalesce(v_member.membership_status,'') <> 'active' then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  if coalesce(v_member.status,'') <> 'active' then raise exception 'MEMBER_DISABLED'; end if;

  select * into v_settings from public.booking_settings where id = 1 for share;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;

  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then raise exception 'INVALID_BOOKING_PARTICIPANTS'; end if;
  v_party_size := jsonb_array_length(p_participants);
  if v_party_size < 1 or v_party_size > v_settings.max_party_size then raise exception 'INVALID_PARTY_SIZE'; end if;

  if p_technician_id is null and v_settings.require_primary_technician then raise exception 'BOOKING_PRIMARY_TECHNICIAN_REQUIRED'; end if;
  if p_technician_id is not null then
  select * into v_technician from public.booking_technicians where id = p_technician_id for share;
  if not found then raise exception 'BOOKING_TECHNICIAN_NOT_FOUND'; end if;
  if not v_technician.is_active then raise exception 'BOOKING_TECHNICIAN_DISABLED'; end if;
  end if;

  for v_participant in select value from jsonb_array_elements(p_participants) loop
    v_position := v_position + 1;
    v_participant_duration := 0;
    if jsonb_typeof(v_participant->'items') <> 'array' or jsonb_array_length(v_participant->'items') < 1 or jsonb_array_length(v_participant->'items') > 20 then
      raise exception 'INVALID_BOOKING_ITEMS';
    end if;
    v_seen := array[]::uuid[];
    for v_item in select value from jsonb_array_elements(v_participant->'items') loop
      begin
        v_service_id := (v_item->>'serviceId')::uuid;
        v_quantity := coalesce((v_item->>'quantity')::integer,1);
      exception when others then raise exception 'INVALID_BOOKING_ITEMS'; end;
      if v_service_id = '00000000-0000-4000-8000-000000000010' then raise exception 'INVALID_BOOKING_ITEMS'; end if;
      if v_quantity < 1 or v_quantity > 2 then raise exception 'INVALID_BOOKING_QUANTITY'; end if;
      if v_service_id = any(v_seen) then raise exception 'DUPLICATE_BOOKING_SERVICE'; end if;
      v_seen := array_append(v_seen, v_service_id);
      select * into v_service from public.booking_services where id = v_service_id for share;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
      if not v_service.is_active then raise exception 'BOOKING_SERVICE_DISABLED'; end if;
      if v_primary_service_id is null then v_primary_service_id := v_service_id; end if;
      v_participant_duration := v_participant_duration + (v_service.duration_minutes * v_quantity);
    end loop;
    v_total_duration := greatest(v_total_duration, v_participant_duration);
  end loop;

  select * into v_store from public.booking_services where id = '00000000-0000-4000-8000-000000000010' for share;
  if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
  if not v_store.is_active then raise exception 'BOOKING_SERVICE_DISABLED'; end if;
  v_total_duration := v_total_duration + v_store.duration_minutes;

  if v_total_duration < 1 or v_total_duration > 1440 then raise exception 'INVALID_BOOKING_DURATION'; end if;
  if p_booking_date < public.booking_business_date(clock_timestamp() at time zone 'Asia/Taipei',v_settings.work_start_time,v_settings.work_end_time) + coalesce(v_settings.min_advance_days,0) then raise exception 'BOOKING_TOO_EARLY'; end if;
  if public.booking_slot_start_at(p_booking_date,p_start_time,v_settings.work_start_time,v_settings.work_end_time) <= (clock_timestamp() at time zone 'Asia/Taipei') then raise exception 'BOOKING_TIME_PASSED'; end if;
  if extract(second from p_start_time) <> 0 then raise exception 'INVALID_BOOKING_SLOT'; end if;
  v_end_time := p_start_time + make_interval(mins => v_total_duration);
  if not public.booking_slot_fits(p_booking_date,p_start_time,v_total_duration,v_settings.work_start_time,v_settings.work_end_time,v_settings.slot_interval_minutes) then raise exception 'INVALID_BOOKING_SLOT'; end if;

  if p_contact_source not in ('member','custom') then raise exception 'INVALID_BOOKING_CONTACT'; end if;
  if p_contact_source = 'custom' and (nullif(btrim(coalesce(p_contact_surname,'')),'') is null or p_contact_salutation not in ('mr','ms') or nullif(btrim(coalesce(p_contact_phone,'')),'') is null) then
    raise exception 'INVALID_BOOKING_CONTACT';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_booking_date::text || ':' || coalesce(p_technician_id::text,'onsite'),0));
  begin
    insert into public.bookings(
      request_id, service_id, member_id, booking_date, start_time, end_time, total_duration_minutes,
      status, member_note, technician_id, party_size, contact_source, contact_surname, contact_salutation, contact_phone
    ) values (
      btrim(p_request_id), v_primary_service_id, p_member_id, p_booking_date, p_start_time, v_end_time, v_total_duration,
      'pending', left(coalesce(p_member_note,''),500), p_technician_id, v_party_size, p_contact_source,
      case when p_contact_source='custom' then left(btrim(p_contact_surname),40) else null end,
      case when p_contact_source='custom' then p_contact_salutation else null end,
      case when p_contact_source='custom' then left(btrim(p_contact_phone),20) else null end
    ) returning * into v_booking;
  exception when exclusion_violation or unique_violation then raise exception 'BOOKING_SLOT_TAKEN'; end;

  v_position := 0;
  for v_participant in select value from jsonb_array_elements(p_participants) loop
    v_position := v_position + 1;
    insert into public.booking_participants(booking_id, position) values (v_booking.id, v_position) returning id into v_participant_id;
    for v_item in select value from jsonb_array_elements(v_participant->'items') loop
      v_service_id := (v_item->>'serviceId')::uuid;
      v_quantity := coalesce((v_item->>'quantity')::integer,1);
      select * into v_service from public.booking_services where id = v_service_id;
      insert into public.booking_participant_items(participant_id, service_id, service_title, unit_duration_minutes, unit_price_amount, quantity)
      values (v_participant_id, v_service.id, v_service.title, v_service.duration_minutes, v_service.price_amount, v_quantity);
      insert into public.booking_items(booking_id, service_id, service_title, unit_duration_minutes, unit_price_amount, quantity, service_type, counts_toward_membership)
      values (v_booking.id, v_service.id, v_service.title, v_service.duration_minutes, v_service.price_amount, v_quantity, v_service.service_type, v_service.counts_toward_membership)
      on conflict (booking_id, service_id) do update set quantity = public.booking_items.quantity + excluded.quantity;
    end loop;
  end loop;

  insert into public.booking_items(booking_id, service_id, service_title, unit_duration_minutes, unit_price_amount, quantity, service_type, counts_toward_membership)
  values (v_booking.id, v_store.id, v_store.title, v_store.duration_minutes, v_store.price_amount, 1, v_store.service_type, v_store.counts_toward_membership)
  on conflict (booking_id, service_id) do update set quantity = excluded.quantity;

  return v_booking;
end;
$function$;

CREATE OR REPLACE FUNCTION public.complete_booking_with_rewards_request(p_booking_id uuid, p_expected_updated_at timestamp with time zone, p_actor text, p_admin_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- Completion of an existing booking is never blocked by a later setting change.
  -- The independent primary-technician-only reward policy still selects matching items.
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

CREATE OR REPLACE FUNCTION public.register_accessible_receipt_with_benefits_request(p_receipt_id text, p_expected_receipt_updated_at timestamp with time zone, p_actor text, p_booking_id uuid, p_booking_date date, p_start_time time without time zone, p_items jsonb, p_benefits jsonb, p_admin_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r public.booking_receipts%rowtype;
  b public.bookings%rowtype;
  m public.members%rowtype;
  s public.booking_services%rowtype;
  settings public.booking_settings%rowtype;
  item jsonb;
  minutes integer;
  quantity integer;
  total integer := 0;
  participant uuid;
  store_id constant uuid := '00000000-0000-4000-8000-000000000010';
  store public.booking_services%rowtype;
  start_at timestamp;
  settlement jsonb;
begin
  perform 1 from public.admins where line_user_id = p_actor and role = 'admin' and status = 'active';
  if not found then raise exception 'ADMIN_REQUIRED'; end if;

  p_benefits := coalesce(p_benefits, '[]'::jsonb);
  if jsonb_typeof(p_benefits) <> 'array' or jsonb_array_length(p_benefits) > 20 then
    raise exception 'INVALID_BOOKING_BENEFITS';
  end if;

  select * into r from public.booking_receipts where receipt_id = p_receipt_id;
  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;

  select * into m from public.members where id = r.member_id for update;
  if m.status <> 'active' or m.membership_status <> 'active' then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select * into r from public.booking_receipts where receipt_id = p_receipt_id for update;
  if r.submission_mode <> 'accessible' then raise exception 'RECEIPT_NOT_PENDING'; end if;

  if r.status = 'bound' then
    select jsonb_build_object(
      'bookingId', booking_id,
      'serviceMinutes', service_minutes,
      'rewards', reward_details
    )
      into settlement
    from public.booking_completion_settlements
    where booking_id = r.booking_id;

    return jsonb_build_object(
      'bookingId', r.booking_id,
      'receiptId', r.receipt_id,
      'settlement', settlement,
      'alreadyApplied', true
    );
  end if;

  if r.status <> 'awaiting_review' or r.booking_id is not null then raise exception 'RECEIPT_NOT_PENDING'; end if;
  if p_expected_receipt_updated_at is null or r.updated_at <> p_expected_receipt_updated_at then raise exception 'BOOKING_CONFLICT'; end if;

  if p_booking_id is not null then
    select * into b from public.bookings where id = p_booking_id for update;
    if not found or b.member_id <> r.member_id then raise exception 'BOOKING_NOT_OWNED'; end if;
    if b.status not in ('confirmed', 'completed') then raise exception 'INVALID_BOOKING_TRANSITION'; end if;
    if b.end_at > (clock_timestamp() at time zone 'Asia/Taipei') then raise exception 'BOOKING_NOT_FINISHED_YET'; end if;
    if exists(
      select 1
      from public.booking_receipts
      where booking_id = b.id
        and status in ('pending_upload', 'awaiting_review', 'bound')
    ) then
      raise exception 'BOOKING_ALREADY_COMPLETED_WITH_RECEIPT';
    end if;
  else
    if p_booking_date is null or p_start_time is null or extract(second from p_start_time) <> 0 then
      raise exception 'INVALID_BOOKING_SLOT';
    end if;
    if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then
      raise exception 'INVALID_BOOKING_ITEMS';
    end if;
    if (select count(distinct x->>'serviceId') from jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) then
      raise exception 'INVALID_BOOKING_ITEMS';
    end if;

    select * into settings from public.booking_settings where id = 1 for share;
    if settings.require_primary_technician and settings.primary_technician_id is null then raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING'; end if;
    if settings.primary_technician_id is not null then
    perform 1 from public.booking_technicians where id = settings.primary_technician_id and is_active;
    if not found then raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING'; end if;
    end if;

    select * into store
    from public.booking_services
    where id = store_id and is_active and deleted_at is null;
    if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;

    for item in select value from jsonb_array_elements(p_items) loop
      select * into s
      from public.booking_services
      where id = (item->>'serviceId')::uuid
        and is_active
        and deleted_at is null
        and id <> store_id
      for share;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;

      minutes := (item->>'minutes')::integer;
      quantity := (item->>'quantity')::integer;
      if minutes is null or minutes not between 1 and 720 or quantity is null or quantity not between 1 and 20 then
        raise exception 'INVALID_BOOKING_ITEMS';
      end if;
      total := total + minutes * quantity;
    end loop;

    total := total + store.duration_minutes;
    if total not between 1 and 1439 then raise exception 'INVALID_BOOKING_DURATION'; end if;

    start_at := p_booking_date + p_start_time
      + case
          when settings.work_end_time < settings.work_start_time and p_start_time < settings.work_end_time
            then interval '1 day'
          else interval '0 days'
        end;
    if start_at + make_interval(mins => total) > (clock_timestamp() at time zone 'Asia/Taipei') then
      raise exception 'BOOKING_NOT_FINISHED_YET';
    end if;

    insert into public.bookings(
      request_id, service_id, member_id, booking_date, start_time, end_time, status,
      total_duration_minutes, technician_id, party_size, confirmed_by, confirmed_at, receipt_submission_id,
      contact_source, contact_surname, contact_salutation, contact_phone
    )
    values(
      'receipt-register:' || r.id::text,
      (p_items->0->>'serviceId')::uuid,
      r.member_id,
      p_booking_date,
      p_start_time,
      (p_start_time + make_interval(mins => total))::time,
      'confirmed',
      total,
      settings.primary_technician_id,
      1,
      p_actor,
      now(),
      r.receipt_id,
      'member',
      m.surname,
      m.salutation,
      m.phone
    )
    returning * into b;

    insert into public.booking_participants(booking_id, position, technician_id)
    values(b.id, 1, settings.primary_technician_id)
    returning id into participant;

    for item in select value from jsonb_array_elements(p_items) loop
      select * into s from public.booking_services where id = (item->>'serviceId')::uuid;

      insert into public.booking_items(
        booking_id, service_id, service_title, unit_duration_minutes, quantity,
        unit_price_amount, service_type, counts_toward_membership
      )
      values(
        b.id, s.id, s.title, (item->>'minutes')::integer, (item->>'quantity')::integer,
        s.price_amount, s.service_type, s.counts_toward_membership
      );

      insert into public.booking_participant_items(
        participant_id, service_id, service_title, unit_duration_minutes, unit_price_amount, quantity
      )
      values(
        participant, s.id, s.title, (item->>'minutes')::integer, s.price_amount, (item->>'quantity')::integer
      );
    end loop;

    insert into public.booking_items(
      booking_id, service_id, service_title, unit_duration_minutes, quantity,
      unit_price_amount, service_type, counts_toward_membership
    )
    values(b.id, store.id, store.title, store.duration_minutes, 1, store.price_amount, store.service_type, false);

    insert into public.booking_participant_items(
      participant_id, service_id, service_title, unit_duration_minutes, unit_price_amount, quantity
    )
    values(participant, store.id, store.title, store.duration_minutes, store.price_amount, 1);
  end if;

  if b.status = 'confirmed' then
    perform public.replace_booking_benefit_selections_request(
      b.id,
      r.member_id,
      p_benefits
    );
  elsif jsonb_array_length(p_benefits) > 0 then
    raise exception 'BOOKING_NOT_EDITABLE';
  end if;

  update public.booking_receipts set booking_id = b.id where id = r.id;

  if b.status = 'completed' then
    select jsonb_build_object(
      'bookingId', booking_id,
      'serviceMinutes', service_minutes,
      'rewards', reward_details
    )
      into settlement
    from public.booking_completion_settlements
    where booking_id = b.id;
    if settlement is null then raise exception 'BOOKING_COMPLETION_REQUIRES_SETTLEMENT'; end if;
    update public.booking_receipts
    set status = 'bound', bound_at = now(), updated_at = now()
    where id = r.id;
  else
    settlement := public.admin_confirm_booking_receipt_request(
      b.id,
      b.updated_at,
      p_actor,
      left(coalesce(p_admin_note, ''), 500)
    )->'settlement';
  end if;

  insert into public.audit_logs(
    audit_id, actor_line_user_id, actor_role, action, target_type, target_id, result, detail
  )
  values(
    public.new_public_id('AUD'),
    p_actor,
    'admin',
    'admin.booking.receipt.register',
    'booking',
    b.id::text,
    'success',
    jsonb_build_object(
      'receiptId', r.receipt_id,
      'linkedExisting', p_booking_id is not null,
      'benefitCount', jsonb_array_length(p_benefits)
    )
  );

  return jsonb_build_object(
    'bookingId', b.id,
    'receiptId', r.receipt_id,
    'settlement', settlement,
    'alreadyApplied', false
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.issue_fixed_tickets(p_business_date date DEFAULT ((now() AT TIME ZONE 'Asia/Taipei'::text))::date, p_member_id uuid DEFAULT NULL::uuid, p_template_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_template public.fixed_ticket_templates%rowtype;
  v_member record;
  v_event public.event_tickets%rowtype;
  v_year integer;
  v_month integer;
  v_prev date;
  v_next date;
  v_candidate date;
  v_cycle_start date;
  v_cycle_end date;
  v_valid_until date;
  v_cycle_key text;
  v_event_cycle_key text;
  v_title text;
  v_event_public_id text;
  v_grant_id uuid;
  v_claim_id text;
  v_claim_count integer;
  v_issued integer := 0;
  v_queued integer := 0;
  v_templates integer := 0;
begin
  update public.event_ticket_claims c
  set status = 'expired', updated_at = now()
  from public.event_tickets e
  where c.event_ticket_id = e.id
    and e.fixed_ticket_template_id is not null
    and e.ends_on is not null
    and e.ends_on < p_business_date
    and c.status = 'claimed'
    and (p_template_id is null or e.fixed_ticket_template_id = p_template_id)
    and (p_member_id is null or c.member_id = p_member_id);

  update public.event_tickets
  set status = 'archived',
      updated_by = 'fixed-ticket-automation',
      updated_at = now()
  where fixed_ticket_template_id is not null
    and ends_on is not null
    and ends_on < p_business_date
    and status = 'active'
    and (p_template_id is null or fixed_ticket_template_id = p_template_id)
    and p_member_id is null;

  for v_template in
    select *
    from public.fixed_ticket_templates
    where status = 'active'
      and deleted_at is null
      and (p_template_id is null or id = p_template_id)
    order by created_at, id
  loop
    v_templates := v_templates + 1;
    v_year := extract(year from p_business_date)::integer;
    v_month := extract(month from p_business_date)::integer;

    if v_template.schedule_type = 'birthday_month' then
      v_cycle_start := date_trunc('month', p_business_date)::date;
      v_cycle_end := (date_trunc('month', p_business_date) + interval '1 month - 1 day')::date;
      v_event_cycle_key := 'birthday-month:' || to_char(v_cycle_start, 'YYYY-MM');
      v_cycle_key := 'birthday:' || extract(year from p_business_date)::integer::text;
    elsif v_template.schedule_type = 'weekly' then
      v_cycle_start := p_business_date - (((extract(isodow from p_business_date)::integer - v_template.schedule_weekday + 7) % 7))::integer;
      v_cycle_end := v_cycle_start + 6;
      v_cycle_key := 'week:' || to_char(v_cycle_start, 'IYYY-IW');
      v_event_cycle_key := v_cycle_key;
    elsif v_template.schedule_type = 'monthly' then
      v_candidate := public.fixed_schedule_date(v_year, v_month, v_template.schedule_day);
      if p_business_date < v_candidate then
        v_prev := (date_trunc('month', p_business_date) - interval '1 month')::date;
        v_cycle_start := public.fixed_schedule_date(
          extract(year from v_prev)::integer,
          extract(month from v_prev)::integer,
          v_template.schedule_day
        );
      else
        v_cycle_start := v_candidate;
      end if;
      v_next := (date_trunc('month', v_cycle_start) + interval '1 month')::date;
      v_cycle_end := public.fixed_schedule_date(
        extract(year from v_next)::integer,
        extract(month from v_next)::integer,
        v_template.schedule_day
      ) - 1;
      v_cycle_key := 'month:' || to_char(v_cycle_start, 'YYYY-MM');
      v_event_cycle_key := v_cycle_key;
    else
      v_candidate := public.fixed_schedule_date(v_year, v_template.schedule_month, v_template.schedule_day);
      if p_business_date < v_candidate then
        v_cycle_start := public.fixed_schedule_date(v_year - 1, v_template.schedule_month, v_template.schedule_day);
      else
        v_cycle_start := v_candidate;
      end if;
      v_cycle_end := public.fixed_schedule_date(
        extract(year from v_cycle_start)::integer + 1,
        v_template.schedule_month,
        v_template.schedule_day
      ) - 1;
      v_cycle_key := 'year:' || extract(year from v_cycle_start)::integer::text;
      v_event_cycle_key := v_cycle_key;
    end if;

    if v_template.expiry_mode = 'fixed_date' then
      v_valid_until := v_template.expiry_date;
    elsif v_template.expiry_mode = 'week_end' then
      v_valid_until := p_business_date + (7 - extract(isodow from p_business_date)::integer);
    elsif v_template.expiry_mode = 'days_after_issue' then
      v_valid_until := p_business_date + (v_template.expiry_days - 1);
    else
      v_valid_until := (date_trunc('month', v_cycle_start) + interval '1 month - 1 day')::date;
    end if;

    if v_valid_until is null or v_valid_until < p_business_date then
      continue;
    end if;

    v_title := replace(
      replace(v_template.title, '{year}', extract(year from v_cycle_start)::integer::text),
      '{month}', extract(month from v_cycle_start)::integer::text
    );
    v_event_public_id := 'FIXED-' || v_template.fixed_ticket_id || '-' || replace(replace(v_event_cycle_key, ':', '-'), '/', '-');

    insert into public.event_tickets(
      event_ticket_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,
      starts_on,ends_on,quota,accent,allowed_tier_keys,created_by,updated_by,activity_url,activity_link_name,
      fixed_ticket_template_id,fixed_cycle_key
    ) values (
      v_event_public_id,v_title,'coupon',v_template.description,v_template.usage_method,v_template.usage_instructions,
      '[]'::jsonb,'active',v_cycle_start,v_valid_until,v_template.quota,lower(v_template.accent),
      v_template.allowed_tier_keys,'fixed-ticket-automation','fixed-ticket-automation','','',v_template.id,v_event_cycle_key
    )
    on conflict (fixed_ticket_template_id, fixed_cycle_key)
      where fixed_ticket_template_id is not null and fixed_cycle_key is not null
    do update set
      title = excluded.title,
      description = excluded.description,
      usage_method = excluded.usage_method,
      usage_instructions = excluded.usage_instructions,
      status = 'active',
      starts_on = excluded.starts_on,
      ends_on = excluded.ends_on,
      quota = excluded.quota,
      accent = excluded.accent,
      allowed_tier_keys = excluded.allowed_tier_keys,
      updated_by = 'fixed-ticket-automation',
      updated_at = now(),
      deleted_at = null
    returning * into v_event;

    perform public.sync_fixed_ticket_calendar_item(v_template.id, v_event.id);

    for v_member in
      select m.id, m.line_user_id, m.display_name, m.birthday, m.is_test_account
      from public.members m
      where m.status = 'active'
        and m.membership_status = 'active'
        and (p_member_id is null or m.id = p_member_id)
        and (v_template.created_by not like 'qa:e2e:%' or coalesce(m.is_test_account, false))
        and (
          v_template.schedule_type <> 'birthday_month'
          or (m.birthday is not null and extract(month from m.birthday)::integer = extract(month from v_cycle_start)::integer)
        )
        and public.current_tier_key(m.id) = any(v_template.allowed_tier_keys)
      order by coalesce(m.joined_at, m.created_at), m.id
    loop
      if v_template.quota > 0 then
        select count(*)::integer into v_claim_count
        from public.event_ticket_claims
        where event_ticket_id = v_event.id;
        exit when v_claim_count >= v_template.quota;
      end if;

      v_grant_id := null;
      insert into public.fixed_ticket_grants(
        fixed_ticket_template_id,member_id,cycle_key,cycle_start,cycle_end,event_ticket_id,status
      ) values (
        v_template.id,v_member.id,v_cycle_key,v_cycle_start,v_cycle_end,v_event.id,'reserved'
      )
      on conflict (fixed_ticket_template_id, member_id, cycle_key) do nothing
      returning id into v_grant_id;

      if v_grant_id is null then continue; end if;

      v_claim_id := public.new_public_id('EC');
      insert into public.event_ticket_claims(
        claim_id,event_ticket_id,member_id,ticket_type,ticket_title,ticket_description,
        usage_method,usage_instructions,prizes,status,claimed_at
      ) values (
        v_claim_id,v_event.id,v_member.id,'coupon',v_event.title,v_event.description,
        v_event.usage_method,v_event.usage_instructions,'[]'::jsonb,'claimed',now()
      )
      on conflict (event_ticket_id, member_id) do nothing;

      select c.claim_id into v_claim_id
      from public.event_ticket_claims c
      where c.event_ticket_id = v_event.id
        and c.member_id = v_member.id
      limit 1;

      if v_claim_id is null then
        update public.fixed_ticket_grants
        set status = 'failed',
            notification_error = 'CLAIM_CREATE_FAILED',
            updated_at = now()
        where id = v_grant_id;
        continue;
      end if;

      update public.fixed_ticket_grants
      set claim_id = v_claim_id,
          status = 'issued',
          notification_error = '',
          updated_at = now()
      where id = v_grant_id;
      v_issued := v_issued + 1;

      if v_template.notify_line and not coalesce(v_member.is_test_account, false) then
        insert into public.scheduled_grant_messages(
          schedule_id,request_id,member_id,line_user_id,scheduled_for,message_text,status,created_by,fixed_ticket_grant_id,notification_business_date
        ) values (
          'FIXED-' || v_template.fixed_ticket_id || '-' || replace(v_cycle_key, ':', '-') || '-' || v_member.id::text,
          'FIXED-' || v_template.fixed_ticket_id || '-' || replace(v_cycle_key, ':', '-') || '-' || v_member.id::text,
          v_member.id,
          v_member.line_user_id,
          greatest(now(), (p_business_date + coalesce(v_template.notify_time, (now() at time zone 'Asia/Taipei')::time)) at time zone 'Asia/Taipei'),
          (case when v_template.schedule_type = 'birthday_month' then '🎂 ' else '🎁 ' end) ||
          coalesce(nullif(v_member.display_name, ''), '會員') || '，你已獲得「' || v_event.title || '」' || E'\n\n' ||
          v_event.description || E'\n\n' ||
          '使用期限：' || to_char(v_cycle_start, 'YYYY/MM/DD') || ' ～ ' || to_char(v_valid_until, 'YYYY/MM/DD'),
          'pending',
          'fixed-ticket-automation',
          v_grant_id,
          p_business_date
        )
        on conflict (request_id) do nothing;
        if found then v_queued := v_queued + 1; end if;
      end if;

      insert into public.audit_logs(
        audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
      ) values (
        public.new_public_id('AUD'),
        'system',
        'system',
        'fixed_ticket.issue',
        'member',
        v_member.line_user_id,
        'success',
        jsonb_build_object(
          'fixedTicketId',v_template.fixed_ticket_id,
          'scheduleType',v_template.schedule_type,
          'expiryMode',v_template.expiry_mode,
          'expiryDays',v_template.expiry_days,
          'cycleKey',v_cycle_key,
          'eventCycleKey',v_event_cycle_key,
          'cycleStart',v_cycle_start,
          'cycleEnd',v_cycle_end,
          'validUntil',v_valid_until,
          'eventTicketId',v_event.event_ticket_id,
          'claimId',v_claim_id
        )
      );
    end loop;
  end loop;

  return jsonb_build_object(
    'businessDate',p_business_date,
    'templatesChecked',v_templates,
    'issued',v_issued,
    'queued',v_queued
  );
end;
$function$;

-- Saving a template retimes unsent jobs atomically. Successful jobs retain their identity.
create or replace function public.sync_fixed_ticket_notification_settings()
returns trigger language plpgsql set search_path='public','pg_temp' as $$
begin
  if new.notify_line is not distinct from old.notify_line and new.notify_time is not distinct from old.notify_time
    and new.status is not distinct from old.status and new.deleted_at is not distinct from old.deleted_at then return new; end if;
  if not new.notify_line or new.status <> 'active' or new.deleted_at is not null then
    update public.scheduled_grant_messages q set status='cancelled',last_error='FIXED_NOTIFICATION_DISABLED',updated_at=now()
    from public.fixed_ticket_grants g
    where q.fixed_ticket_grant_id=g.id and g.fixed_ticket_template_id=new.id and q.status in ('pending','sending');
  else
    update public.scheduled_grant_messages q set status='pending',last_error='',
      scheduled_for=greatest(now(),case when new.notify_time is null then q.created_at
        else (q.notification_business_date+new.notify_time) at time zone 'Asia/Taipei' end),updated_at=now()
    from public.fixed_ticket_grants g
    where q.fixed_ticket_grant_id=g.id and g.fixed_ticket_template_id=new.id
      and (q.status in ('pending','sending') or (q.status='cancelled' and q.last_error='FIXED_NOTIFICATION_DISABLED'));
  end if;
  return new;
end; $$;
revoke all on function public.sync_fixed_ticket_notification_settings() from public,anon,authenticated;
create trigger fixed_ticket_notification_settings_change after update of notify_line,notify_time,status,deleted_at
on public.fixed_ticket_templates for each row execute function public.sync_fixed_ticket_notification_settings();

-- Service-only, fail-closed eligibility check immediately before delivery.
create or replace function public.fixed_ticket_notification_delivery(p_message_id uuid)
returns jsonb language plpgsql set search_path='public','pg_temp' as $$
declare q public.scheduled_grant_messages%rowtype; g public.fixed_ticket_grants%rowtype;
  t public.fixed_ticket_templates%rowtype; m public.members%rowtype; e public.event_tickets%rowtype;
  today date := (now() at time zone 'Asia/Taipei')::date;
begin
  select * into q from public.scheduled_grant_messages where id=p_message_id;
  if not found then return jsonb_build_object('action','cancel','reason','NOTIFICATION_NOT_FOUND'); end if;
  if q.request_id not like 'FIXED-%' then return jsonb_build_object('action','send'); end if;
  select * into g from public.fixed_ticket_grants where id=q.fixed_ticket_grant_id;
  if not found or g.status <> 'issued' then return jsonb_build_object('action','cancel','reason','FIXED_GRANT_UNAVAILABLE'); end if;
  select * into t from public.fixed_ticket_templates where id=g.fixed_ticket_template_id;
  if not found or not t.notify_line or t.status <> 'active' or t.deleted_at is not null then
    return jsonb_build_object('action','cancel','reason','FIXED_NOTIFICATION_DISABLED');
  end if;
  select * into m from public.members where id=q.member_id;
  if not found or m.id <> g.member_id or m.line_user_id <> q.line_user_id or m.status <> 'active'
    or m.membership_status <> 'active' or m.is_test_account or not (public.current_tier_key(m.id)=any(t.allowed_tier_keys)) then
    return jsonb_build_object('action','cancel','reason','FIXED_MEMBER_INELIGIBLE');
  end if;
  select * into e from public.event_tickets where id=g.event_ticket_id;
  if not found or e.status <> 'active' or e.deleted_at is not null or e.starts_on > today or e.ends_on < today
    or not (public.current_tier_key(m.id)=any(e.allowed_tier_keys))
    or not exists(select 1 from public.event_ticket_claims c where c.claim_id=g.claim_id and c.member_id=m.id and c.event_ticket_id=e.id and c.status='claimed') then
    return jsonb_build_object('action','cancel','reason','FIXED_TICKET_UNAVAILABLE');
  end if;
  if q.status <> 'sending' then return jsonb_build_object('action','skip','reason','FIXED_NOTIFICATION_CHANGED'); end if;
  if q.scheduled_for > now() then return jsonb_build_object('action','defer','scheduledFor',q.scheduled_for); end if;
  return jsonb_build_object('action','send');
end; $$;
revoke all on function public.fixed_ticket_notification_delivery(uuid) from public,anon,authenticated;
grant execute on function public.fixed_ticket_notification_delivery(uuid) to service_role;

revoke all on function public.register_accessible_receipt_with_benefits_request(text,timestamptz,text,uuid,date,time,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.register_accessible_receipt_with_benefits_request(text,timestamptz,text,uuid,date,time,jsonb,jsonb,text) to service_role;

-- Existing RPC grants are retained by CREATE OR REPLACE; all privileged functions remain service-only.
commit;
