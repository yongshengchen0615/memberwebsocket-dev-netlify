-- Allow an authorized admin Edge Function to replace the actual service-item
-- snapshots for a pending/confirmed booking without changing the reserved
-- booking date or time range. The fixed in-store service remains untouched.

create or replace function public.admin_update_booking_items_request(
  p_booking_id uuid,
  p_expected_updated_at timestamptz,
  p_actor text,
  p_items jsonb
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_booking public.bookings%rowtype;
  v_service public.booking_services%rowtype;
  v_item jsonb;
  v_service_id uuid;
  v_primary_service_id uuid;
  v_seen_service_ids uuid[] := array[]::uuid[];
  v_quantity integer;
  v_item_count integer;
  v_previous_items jsonb;
begin
  select * into v_booking
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if p_expected_updated_at is null or v_booking.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_CONFLICT';
  end if;
  if v_booking.status not in ('pending','confirmed') then
    raise exception 'BOOKING_NOT_EDITABLE';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_BOOKING_ITEMS';
  end if;

  v_item_count := jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 20 then
    raise exception 'INVALID_BOOKING_ITEMS';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'serviceId', bi.service_id,
    'quantity', bi.quantity,
    'serviceTitle', bi.service_title,
    'unitDurationMinutes', bi.unit_duration_minutes,
    'unitPriceAmount', bi.unit_price_amount
  ) order by bi.created_at), '[]'::jsonb)
  into v_previous_items
  from public.booking_items bi
  where bi.booking_id = p_booking_id
    and bi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    begin
      v_service_id := (v_item ->> 'serviceId')::uuid;
      v_quantity := coalesce((v_item ->> 'quantity')::integer, 1);
    exception when others then
      raise exception 'INVALID_BOOKING_ITEMS';
    end;

    if v_service_id = '00000000-0000-4000-8000-000000000010'::uuid then
      raise exception 'BOOKING_SYSTEM_SERVICE_IMMUTABLE';
    end if;
    if v_quantity < 1 or v_quantity > 2 then
      raise exception 'INVALID_BOOKING_QUANTITY';
    end if;
    if v_service_id = any(v_seen_service_ids) then
      raise exception 'DUPLICATE_BOOKING_SERVICE';
    end if;
    v_seen_service_ids := array_append(v_seen_service_ids, v_service_id);

    select * into v_service
    from public.booking_services
    where id = v_service_id
      and deleted_at is null
    for share;

    if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
    if v_primary_service_id is null then v_primary_service_id := v_service_id; end if;
  end loop;

  delete from public.booking_items
  where booking_id = p_booking_id
    and service_id <> '00000000-0000-4000-8000-000000000010'::uuid;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_service_id := (v_item ->> 'serviceId')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 1);
    select * into v_service from public.booking_services where id = v_service_id;

    insert into public.booking_items(
      booking_id,
      service_id,
      service_title,
      unit_duration_minutes,
      quantity
    ) values (
      p_booking_id,
      v_service.id,
      v_service.title,
      v_service.duration_minutes,
      v_quantity
    );
  end loop;

  -- Keep booking_date/start_time/end_time/total_duration_minutes unchanged so
  -- the original reserved schedule remains an auditable scheduling record.
  update public.bookings
  set service_id = v_primary_service_id
  where id = p_booking_id
  returning * into v_booking;

  insert into public.booking_audit_events(
    actor_line_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    metadata
  ) values (
    left(coalesce(p_actor, ''), 255),
    'admin',
    'BOOKING_ITEMS_UPDATED',
    'booking',
    p_booking_id::text,
    'success',
    jsonb_build_object(
      'previousItems', coalesce(v_previous_items, '[]'::jsonb),
      'items', p_items,
      'status', v_booking.status,
      'schedulePreserved', true
    )
  );

  return v_booking;
end;
$$;

revoke all on function public.admin_update_booking_items_request(uuid,timestamptz,text,jsonb) from public, anon, authenticated;
grant execute on function public.admin_update_booking_items_request(uuid,timestamptz,text,jsonb) to service_role;
