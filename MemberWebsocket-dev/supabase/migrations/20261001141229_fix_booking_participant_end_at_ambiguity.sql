create or replace function public.admin_update_booking_participant_items_request(
  p_booking_id uuid,
  p_expected_updated_at timestamptz,
  p_actor text,
  p_participants jsonb
)
returns public.bookings
language plpgsql
set search_path to ''
as $function$
declare
  b public.bookings%rowtype;
  cfg public.booking_settings%rowtype;
  participant public.booking_participants%rowtype;
  service public.booking_services%rowtype;
  person jsonb;
  item jsonb;
  v_service_id uuid;
  primary_service_id uuid;
  v_quantity integer;
  v_position integer;
  seen_positions integer[] := '{}';
  seen_services uuid[];
  participant_count integer;
  store_minutes integer;
  minutes integer;
  max_minutes integer := 0;
  total_minutes integer;
  v_end_time time;
  before_items jsonb;
begin
  if not exists (
    select 1 from public.admins as a
    where a.line_user_id = p_actor and a.role = 'admin' and a.status = 'active'
  ) then raise exception 'ADMIN_REQUIRED'; end if;

  select bk.* into b from public.bookings as bk where bk.id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if p_expected_updated_at is null or b.updated_at <> p_expected_updated_at then raise exception 'BOOKING_CONFLICT'; end if;
  if b.status not in ('pending','confirmed') then raise exception 'BOOKING_NOT_EDITABLE'; end if;
  if b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null then raise exception 'BOOKING_CANCELLATION_PENDING'; end if;

  select bs.* into cfg from public.booking_settings as bs where bs.id = 1 for share;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;

  select count(*) into participant_count
  from public.booking_participants as bp_count
  where bp_count.booking_id = b.id;

  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then raise exception 'INVALID_BOOKING_PARTICIPANTS'; end if;
  if participant_count < 1 or participant_count <> b.party_size or jsonb_array_length(p_participants) <> participant_count then
    raise exception 'INVALID_BOOKING_PARTICIPANTS';
  end if;

  select coalesce(jsonb_agg(to_jsonb(bpi_before) order by bp_before.position,bpi_before.service_id),'[]'::jsonb)
  into before_items
  from public.booking_participant_items as bpi_before
  join public.booking_participants as bp_before on bp_before.id = bpi_before.participant_id
  where bp_before.booking_id = b.id;

  select sum(bi_store.unit_duration_minutes * bi_store.quantity)::integer
  into store_minutes
  from public.booking_items as bi_store
  where bi_store.booking_id = b.id
    and bi_store.service_id = '00000000-0000-4000-8000-000000000010'::uuid;
  if store_minutes is null then raise exception 'INVALID_BOOKING_ITEMS'; end if;

  for person in select j.value from jsonb_array_elements(p_participants) as j(value) loop
    if coalesce(person->>'position','') !~ '^[1-9][0-9]?$' then raise exception 'INVALID_BOOKING_PARTICIPANTS'; end if;
    v_position := (person->>'position')::integer;
    if v_position = any(seen_positions) then raise exception 'INVALID_BOOKING_PARTICIPANTS'; end if;
    seen_positions := array_append(seen_positions,v_position);

    select bp.* into participant
    from public.booking_participants as bp
    where bp.booking_id = b.id and bp.position = v_position
    for update;
    if not found then raise exception 'INVALID_BOOKING_PARTICIPANTS'; end if;

    if jsonb_typeof(person->'items') is distinct from 'array' then raise exception 'INVALID_BOOKING_ITEMS'; end if;
    if jsonb_array_length(person->'items') not between 1 and 20 then raise exception 'INVALID_BOOKING_ITEMS'; end if;

    minutes := 0;
    seen_services := '{}';
    delete from public.booking_participant_items as bpi_delete
    where bpi_delete.participant_id = participant.id;

    for item in select j.value from jsonb_array_elements(person->'items') as j(value) loop
      begin v_service_id := (item->>'serviceId')::uuid;
      exception when invalid_text_representation then raise exception 'INVALID_BOOKING_ITEMS'; end;
      if v_service_id is null then raise exception 'INVALID_BOOKING_ITEMS'; end if;
      if coalesce(item->>'quantity','') !~ '^[12]$' then raise exception 'INVALID_BOOKING_QUANTITY'; end if;
      v_quantity := (item->>'quantity')::integer;
      if v_service_id = '00000000-0000-4000-8000-000000000010'::uuid then raise exception 'BOOKING_SYSTEM_SERVICE_IMMUTABLE'; end if;
      if v_service_id = any(seen_services) then raise exception 'DUPLICATE_BOOKING_SERVICE'; end if;
      seen_services := array_append(seen_services,v_service_id);

      select bs.* into service
      from public.booking_services as bs
      where bs.id = v_service_id and bs.deleted_at is null
      for share;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;

      if primary_service_id is null then primary_service_id := service.id; end if;
      minutes := minutes + service.duration_minutes * v_quantity;

      insert into public.booking_participant_items(participant_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity)
      values(participant.id,service.id,service.title,service.duration_minutes,service.price_amount,v_quantity);
    end loop;

    max_minutes := greatest(max_minutes,minutes);
    if minutes < 1 or minutes >= 1440 then raise exception 'INVALID_BOOKING_DURATION'; end if;

    if participant.technician_id is not null then
      insert into public.booking_participant_reservations(participant_id,booking_id,technician_id,booking_date,start_time,end_time,is_active)
      values(participant.id,b.id,participant.technician_id,b.booking_date,b.start_time,b.start_time + make_interval(mins => minutes),true)
      on conflict (participant_id) do update set end_time = excluded.end_time, updated_at = now();
    end if;
  end loop;

  total_minutes := max_minutes + store_minutes;
  if total_minutes not between 1 and 1440 then raise exception 'INVALID_BOOKING_DURATION'; end if;
  v_end_time := b.start_time + make_interval(mins => total_minutes);
  if not public.booking_slot_fits(b.booking_date,b.start_time,total_minutes,cfg.work_start_time,cfg.work_end_time,cfg.slot_interval_minutes) then
    raise exception 'INVALID_BOOKING_SLOT';
  end if;

  delete from public.booking_items as bi_delete
  where bi_delete.booking_id = b.id
    and bi_delete.service_id <> '00000000-0000-4000-8000-000000000010'::uuid;

  insert into public.booking_items(booking_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity,service_type,counts_toward_membership)
  select b.id,bpi.service_id,max(bpi.service_title),max(bpi.unit_duration_minutes),max(bpi.unit_price_amount),sum(bpi.quantity)::smallint,
         bs.service_type,bs.counts_toward_membership
  from public.booking_participant_items as bpi
  join public.booking_participants as bp on bp.id = bpi.participant_id
  join public.booking_services as bs on bs.id = bpi.service_id
  where bp.booking_id = b.id
  group by bpi.service_id,bs.service_type,bs.counts_toward_membership;

  update public.bookings as bk
  set service_id = primary_service_id,total_duration_minutes = total_minutes,end_time = v_end_time
  where bk.id = b.id
  returning bk.* into b;

  insert into public.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata,created_at)
  values(p_actor,'admin','BOOKING_ITEMS_UPDATED','booking',b.id::text,'success',
    jsonb_build_object('previousParticipantItems',before_items,'participants',p_participants,'totalDurationMinutes',total_minutes),b.updated_at);

  return b;
exception when exclusion_violation then raise exception 'BOOKING_SLOT_TAKEN';
end;
$function$;
