create or replace function public.admin_update_booking_participant_technicians_request(
  p_booking_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_actor text,
  p_participants jsonb
)
returns public.bookings
language plpgsql
set search_path = ''
as $function$
declare
  b public.bookings%rowtype;
  participant public.booking_participants%rowtype;
  person jsonb;
  v_position integer;
  v_technician_id uuid;
  v_primary_technician_id uuid;
  v_participant_count integer;
  v_duration integer;
  v_seen_positions integer[] := '{}';
  v_before jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1
    from public.admins
    where line_user_id = p_actor
      and role = 'admin'
      and status = 'active'
  ) then
    raise exception 'ADMIN_REQUIRED';
  end if;

  select *
  into b
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;
  if p_expected_updated_at is null or b.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_CONFLICT';
  end if;
  if b.status not in ('pending', 'confirmed') then
    raise exception 'BOOKING_NOT_EDITABLE';
  end if;
  if b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null then
    raise exception 'BOOKING_CANCELLATION_PENDING';
  end if;

  select count(*)
  into v_participant_count
  from public.booking_participants
  where booking_id = b.id;

  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then
    raise exception 'INVALID_BOOKING_PARTICIPANTS';
  end if;
  if v_participant_count < 1
     or v_participant_count <> b.party_size
     or jsonb_array_length(p_participants) <> v_participant_count then
    raise exception 'INVALID_BOOKING_PARTICIPANTS';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'position', p.position,
        'technicianId', coalesce(p.technician_id::text, '')
      )
      order by p.position
    ),
    '[]'::jsonb
  )
  into v_before
  from public.booking_participants p
  where p.booking_id = b.id;

  v_primary_technician_id := public.validate_group_booking_technicians(p_participants);

  -- Clear this booking's own reservations before rebuilding the final assignment.
  -- This allows valid technician swaps (A↔B) without falsely conflicting with
  -- the other participant's old reservation from the same booking.
  delete from public.booking_participant_reservations
  where booking_id = b.id;

  for person in
    select value
    from jsonb_array_elements(p_participants)
  loop
    if coalesce(person->>'position', '') !~ '^[1-9][0-9]?$' then
      raise exception 'INVALID_BOOKING_PARTICIPANTS';
    end if;

    v_position := (person->>'position')::integer;
    if v_position = any(v_seen_positions) then
      raise exception 'INVALID_BOOKING_PARTICIPANTS';
    end if;
    v_seen_positions := array_append(v_seen_positions, v_position);

    select *
    into participant
    from public.booking_participants p
    where p.booking_id = b.id
      and p.position = v_position
    for update;

    if not found then
      raise exception 'INVALID_BOOKING_PARTICIPANTS';
    end if;

    v_technician_id := null;
    if nullif(btrim(coalesce(person->>'technicianId', '')), '') is not null then
      begin
        v_technician_id := (person->>'technicianId')::uuid;
      exception
        when others then
          raise exception 'INVALID_BOOKING_TECHNICIAN';
      end;
    end if;

    update public.booking_participants
    set technician_id = v_technician_id
    where id = participant.id;

    if v_technician_id is not null then
      select coalesce(sum(unit_duration_minutes * quantity), 0)::integer
      into v_duration
      from public.booking_participant_items
      where participant_id = participant.id;

      if v_duration < 1 then
        raise exception 'INVALID_BOOKING_DURATION';
      end if;

      insert into public.booking_participant_reservations(
        participant_id,
        booking_id,
        technician_id,
        booking_date,
        start_time,
        end_time,
        is_active
      )
      values(
        participant.id,
        b.id,
        v_technician_id,
        b.booking_date,
        b.start_time,
        b.start_time + make_interval(mins => v_duration),
        true
      );
    end if;
  end loop;

  update public.bookings
  set technician_id = v_primary_technician_id,
      updated_at = now()
  where id = b.id
  returning * into b;

  insert into public.booking_audit_events(
    actor_line_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    metadata,
    created_at
  )
  values(
    p_actor,
    'admin',
    'BOOKING_PARTICIPANT_TECHNICIANS_UPDATED',
    'booking',
    b.id::text,
    'success',
    jsonb_build_object(
      'previousParticipants', v_before,
      'participants', p_participants,
      'primaryTechnicianId', v_primary_technician_id
    ),
    b.updated_at
  );

  return b;
exception
  when exclusion_violation then
    raise exception 'BOOKING_SLOT_TAKEN';
end;
$function$;

revoke execute on function public.admin_update_booking_participant_technicians_request(
  uuid,
  timestamp with time zone,
  text,
  jsonb
) from public, anon, authenticated;

grant execute on function public.admin_update_booking_participant_technicians_request(
  uuid,
  timestamp with time zone,
  text,
  jsonb
) to service_role;
