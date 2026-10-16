-- Booking v3: make advance-booking days a global booking setting.
-- Legacy booking_services.min_advance_days is retained for backward compatibility,
-- but current booking availability and creation no longer use it.

alter table public.booking_settings
  add column if not exists min_advance_days integer not null default 0;

alter table public.booking_settings
  drop constraint if exists booking_settings_min_advance_days_check;
alter table public.booking_settings
  add constraint booking_settings_min_advance_days_check
  check (min_advance_days between 0 and 365);

-- Preserve the strictest existing behavior when migrating from per-service settings.
-- This avoids silently allowing dates that any existing service previously blocked.
update public.booking_settings
set min_advance_days = coalesce((
  select max(coalesce(min_advance_days, 0))
  from public.booking_services
), 0)
where id = 1;

comment on column public.booking_settings.min_advance_days is
  'Global minimum number of days members must book in advance. Applies to all booking services.';
comment on column public.booking_services.min_advance_days is
  'Legacy compatibility column. Current booking rules use booking_settings.min_advance_days.';

create or replace function public.create_booking_bundle_request(
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

  select * into v_existing
  from public.bookings
  where request_id = p_request_id;

  if found then
    if v_existing.member_id <> p_member_id then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return v_existing;
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

  if jsonb_typeof(p_items) <> 'array' then raise exception 'INVALID_BOOKING_ITEMS'; end if;
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
    insert into public.bookings(
      request_id, service_id, member_id, booking_date, start_time, end_time,
      total_duration_minutes, status, member_note
    ) values (
      btrim(p_request_id), v_primary_service_id, p_member_id, p_booking_date,
      p_start_time, v_end_time, v_total_duration, 'pending', left(coalesce(p_member_note, ''), 500)
    )
    returning * into v_booking;
  exception
    when exclusion_violation or unique_violation then
      raise exception 'BOOKING_SLOT_TAKEN';
  end;

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

  return v_booking;
end;
$$;

revoke execute on function public.create_booking_bundle_request(text, uuid, date, time without time zone, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.create_booking_bundle_request(text, uuid, date, time without time zone, jsonb, text)
  to service_role;
