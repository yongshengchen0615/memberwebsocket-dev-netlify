-- Keep the group-booking Edge Function contract reproducible from repository migrations.
-- These RPCs are service-role only; client authentication/authorization remains in the Edge Function.

create or replace function public.validate_group_booking_technicians(p_participants jsonb)
returns uuid
language plpgsql
set search_path = 'public'
as $$
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
  if v_settings.primary_technician_id is null then raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING'; end if;

  select * into v_technician
  from public.booking_technicians
  where id = v_settings.primary_technician_id
  for share;
  if not found or not v_technician.is_active then raise exception 'BOOKING_PRIMARY_TECHNICIAN_DISABLED'; end if;

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

  if not v_primary_selected then
    raise exception 'BOOKING_PRIMARY_TECHNICIAN_REQUIRED';
  end if;

  return v_settings.primary_technician_id;
end;
$$;

create or replace function public.create_group_booking_request_v2(
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time without time zone,
  p_participants jsonb,
  p_member_note text default '',
  p_contact_source text default 'member',
  p_contact_surname text default null,
  p_contact_salutation text default null,
  p_contact_phone text default null
)
returns public.bookings
language plpgsql
set search_path = 'public'
as $$
declare
  v_primary_technician_id uuid;
  v_booking public.bookings%rowtype;
  v_participant jsonb;
  v_position integer;
  v_participant_id uuid;
  v_technician_id uuid;
  v_duration integer;
begin
  v_primary_technician_id := public.validate_group_booking_technicians(p_participants);

  v_booking := public.create_group_booking_request(
    p_request_id,
    p_member_id,
    p_booking_date,
    p_start_time,
    v_primary_technician_id,
    p_participants,
    p_member_note,
    p_contact_source,
    p_contact_surname,
    p_contact_salutation,
    p_contact_phone
  );

  for v_participant, v_position in
    select value, ordinality::integer
    from jsonb_array_elements(p_participants) with ordinality
  loop
    select id into v_participant_id
    from public.booking_participants
    where booking_id = v_booking.id and position = v_position;
    if not found then raise exception 'INVALID_BOOKING_PARTICIPANTS'; end if;

    v_technician_id := null;
    if nullif(btrim(coalesce(v_participant->>'technicianId','')), '') is not null then
      v_technician_id := (v_participant->>'technicianId')::uuid;
    end if;

    update public.booking_participants
    set technician_id = v_technician_id
    where id = v_participant_id;

    delete from public.booking_participant_reservations where participant_id = v_participant_id;
    if v_technician_id is not null then
      select coalesce(sum(unit_duration_minutes * quantity), 0)::integer
      into v_duration
      from public.booking_participant_items
      where participant_id = v_participant_id;

      if v_duration < 1 then raise exception 'INVALID_BOOKING_DURATION'; end if;

      insert into public.booking_participant_reservations(
        participant_id, booking_id, technician_id, booking_date, start_time, end_time, is_active
      ) values (
        v_participant_id,
        v_booking.id,
        v_technician_id,
        v_booking.booking_date,
        v_booking.start_time,
        v_booking.start_time + make_interval(mins => v_duration),
        v_booking.status in ('pending','confirmed')
      );
    end if;
  end loop;

  return v_booking;
exception
  when exclusion_violation then
    raise exception 'BOOKING_SLOT_TAKEN';
end;
$$;

create or replace function public.update_group_booking_request_v2(
  p_booking_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_actor text,
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time without time zone,
  p_participants jsonb,
  p_member_note text default '',
  p_contact_source text default 'member',
  p_contact_surname text default null,
  p_contact_salutation text default null,
  p_contact_phone text default null
)
returns public.bookings
language plpgsql
set search_path = 'public'
as $$
declare
  v_primary_technician_id uuid;
  v_booking public.bookings%rowtype;
  v_participant jsonb;
  v_position integer;
  v_participant_id uuid;
  v_technician_id uuid;
  v_duration integer;
begin
  v_primary_technician_id := public.validate_group_booking_technicians(p_participants);

  v_booking := public.update_group_booking_request(
    p_booking_id,
    p_expected_updated_at,
    p_actor,
    p_request_id,
    p_member_id,
    p_booking_date,
    p_start_time,
    v_primary_technician_id,
    p_participants,
    p_member_note,
    p_contact_source,
    p_contact_surname,
    p_contact_salutation,
    p_contact_phone
  );

  for v_participant, v_position in
    select value, ordinality::integer
    from jsonb_array_elements(p_participants) with ordinality
  loop
    select id into v_participant_id
    from public.booking_participants
    where booking_id = v_booking.id and position = v_position;
    if not found then raise exception 'INVALID_BOOKING_PARTICIPANTS'; end if;

    v_technician_id := null;
    if nullif(btrim(coalesce(v_participant->>'technicianId','')), '') is not null then
      v_technician_id := (v_participant->>'technicianId')::uuid;
    end if;

    update public.booking_participants
    set technician_id = v_technician_id
    where id = v_participant_id;

    delete from public.booking_participant_reservations where participant_id = v_participant_id;
    if v_technician_id is not null then
      select coalesce(sum(unit_duration_minutes * quantity), 0)::integer
      into v_duration
      from public.booking_participant_items
      where participant_id = v_participant_id;

      if v_duration < 1 then raise exception 'INVALID_BOOKING_DURATION'; end if;

      insert into public.booking_participant_reservations(
        participant_id, booking_id, technician_id, booking_date, start_time, end_time, is_active
      ) values (
        v_participant_id,
        v_booking.id,
        v_technician_id,
        v_booking.booking_date,
        v_booking.start_time,
        v_booking.start_time + make_interval(mins => v_duration),
        v_booking.status in ('pending','confirmed')
      );
    end if;
  end loop;

  return v_booking;
exception
  when exclusion_violation then
    raise exception 'BOOKING_SLOT_TAKEN';
end;
$$;

revoke all on function public.validate_group_booking_technicians(jsonb) from public, anon, authenticated;
revoke all on function public.create_group_booking_request_v2(text,uuid,date,time without time zone,jsonb,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.update_group_booking_request_v2(uuid,timestamp with time zone,text,text,uuid,date,time without time zone,jsonb,text,text,text,text,text) from public, anon, authenticated;

grant execute on function public.validate_group_booking_technicians(jsonb) to service_role;
grant execute on function public.create_group_booking_request_v2(text,uuid,date,time without time zone,jsonb,text,text,text,text,text) to service_role;
grant execute on function public.update_group_booking_request_v2(uuid,timestamp with time zone,text,text,uuid,date,time without time zone,jsonb,text,text,text,text,text) to service_role;
