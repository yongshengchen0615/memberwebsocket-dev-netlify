-- Apply before deploying booking-api and the updated clients. Existing bookings are preserved.
begin;
alter table public.bookings add column if not exists completed_at timestamptz;
alter table public.bookings add column if not exists completed_by text;
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('pending','confirmed','rejected','cancelled','completed'));
create or replace function public.update_booking_bundle_request(
  p_booking_id uuid,
  p_expected_updated_at timestamptz,
  p_actor text,
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time without time zone,
  p_items jsonb,
  p_member_note text default ''
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_settings public.booking_settings%rowtype;
  v_member public.members%rowtype;
  v_existing public.bookings%rowtype;
  v_booking public.bookings%rowtype;
  v_service public.booking_services%rowtype;
  v_item jsonb;
  v_service_id uuid;
  v_primary_service_id uuid;
  v_seen_service_ids uuid[] := array[]::uuid[];
  v_quantity integer;
  v_total_duration integer := 0;
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_local_time time := (now() at time zone 'Asia/Taipei')::time;
  v_end_time time;
  v_item_count integer;
begin
  if p_request_id is null or char_length(btrim(p_request_id)) < 12 or char_length(p_request_id) > 100 then
    raise exception 'INVALID_REQUEST_ID';
  end if;

  select * into v_existing from public.bookings
  where id = p_booking_id and member_id = p_member_id for update;
  if not found then raise exception 'BOOKING_NOT_EDITABLE'; end if;
  if v_existing.request_id = p_request_id then return v_existing; end if;
  if p_expected_updated_at is null or v_existing.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_CONFLICT';
  end if;
  if v_existing.status not in ('pending', 'confirmed')
     or v_existing.booking_date + v_existing.start_time <= (clock_timestamp() at time zone 'Asia/Taipei') then
    raise exception 'BOOKING_NOT_EDITABLE';
  end if;
  select * into v_member
  from public.members
  where id = p_member_id;

  if not found then raise exception 'MEMBER_NOT_FOUND'; end if;
  if coalesce(v_member.membership_status, '') <> 'active' then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  if coalesce(v_member.status, '') <> 'active' then raise exception 'MEMBER_DISABLED'; end if;

  select * into v_settings
  from public.booking_settings
  where id = 1
  for share;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'INVALID_BOOKING_ITEMS'; end if;
  v_item_count := jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 20 then raise exception 'INVALID_BOOKING_ITEMS'; end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    begin
      v_service_id := (v_item ->> 'serviceId')::uuid;
      v_quantity := coalesce((v_item ->> 'quantity')::integer, 1);
    exception when others then
      raise exception 'INVALID_BOOKING_ITEMS';
    end;

    if v_quantity < 1 or v_quantity > 2 then raise exception 'INVALID_BOOKING_QUANTITY'; end if;
    if v_service_id = any(v_seen_service_ids) then raise exception 'DUPLICATE_BOOKING_SERVICE'; end if;
    v_seen_service_ids := array_append(v_seen_service_ids, v_service_id);

    select * into v_service
    from public.booking_services
    where id = v_service_id
    for share;
    if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
    if not v_service.is_active then raise exception 'BOOKING_SERVICE_DISABLED'; end if;

    if v_primary_service_id is null then v_primary_service_id := v_service_id; end if;
    v_total_duration := v_total_duration + (v_service.duration_minutes * v_quantity);
  end loop;

  if v_total_duration < 1 or v_total_duration > 1440 then raise exception 'INVALID_BOOKING_DURATION'; end if;
  if p_booking_date < v_today + coalesce(v_settings.min_advance_days, 0) then raise exception 'BOOKING_TOO_EARLY'; end if;
  if p_booking_date = v_today and p_start_time <= v_local_time then raise exception 'BOOKING_TIME_PASSED'; end if;
  if extract(second from p_start_time) <> 0
     or extract(minute from p_start_time)::integer not in (0, 30) then
    raise exception 'INVALID_BOOKING_SLOT';
  end if;

  v_end_time := p_start_time + make_interval(mins => v_total_duration);
  if v_end_time <= p_start_time
     or p_start_time < v_settings.work_start_time
     or v_end_time > v_settings.work_end_time then
    raise exception 'INVALID_BOOKING_SLOT';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_booking_date::text, 0));

  begin
    update public.bookings set
      request_id = p_request_id, service_id = v_primary_service_id,
      booking_date = p_booking_date, start_time = p_start_time, end_time = v_end_time,
      total_duration_minutes = v_total_duration, status = 'pending',
      member_note = left(coalesce(p_member_note, ''), 500), admin_note = '',
      confirmed_by = null, confirmed_at = null
    where id = p_booking_id returning * into v_booking;
  exception
    when exclusion_violation or unique_violation then
      raise exception 'BOOKING_SLOT_TAKEN';
  end;

  delete from public.booking_items where booking_id = p_booking_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_service_id := (v_item ->> 'serviceId')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 1);
    select * into v_service from public.booking_services where id = v_service_id;

    insert into public.booking_items(
      booking_id, service_id, service_title, unit_duration_minutes, quantity
    ) values (
      v_booking.id, v_service.id, v_service.title, v_service.duration_minutes, v_quantity
    );
  end loop;

  insert into public.booking_audit_events(actor_line_user_id, actor_role, action, target_type, target_id, result, metadata)
  values (p_actor, 'member', 'BOOKING_UPDATED', 'booking', p_booking_id::text, 'success',
    jsonb_build_object('previousDate', v_existing.booking_date, 'previousStartTime', v_existing.start_time,
      'previousStatus', v_existing.status, 'bookingDate', p_booking_date, 'startTime', p_start_time));
  return v_booking;
end;
$$;


revoke all on function public.update_booking_bundle_request(uuid,timestamptz,text,text,uuid,date,time,jsonb,text) from public, anon, authenticated;
grant execute on function public.update_booking_bundle_request(uuid,timestamptz,text,text,uuid,date,time,jsonb,text) to service_role;
commit;
