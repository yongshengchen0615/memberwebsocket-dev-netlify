-- Keep scheduled reservation time internally consistent while allowing
-- administrators to record different on-site service items.
--
-- Invariants:
-- 1. end_time - start_time must equal total_duration_minutes.
-- 2. Every pending/confirmed booking must contain exactly one fixed in-store
--    service (quantity 1, current system duration) plus at least one user service.
-- 3. The legacy single-service booking RPC delegates to the current bundle RPC
--    so old callers cannot reintroduce the historical fixed-30-minute bug.

begin;

create or replace function public.validate_booking_schedule_consistency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_duration_minutes integer;
begin
  if new.end_time <= new.start_time then
    raise exception 'INVALID_BOOKING_DURATION';
  end if;

  v_duration_minutes := round(extract(epoch from (new.end_time - new.start_time)) / 60.0)::integer;
  if v_duration_minutes <> new.total_duration_minutes then
    raise exception 'INVALID_BOOKING_DURATION';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_booking_schedule_consistency() from public, anon, authenticated;
grant execute on function public.validate_booking_schedule_consistency() to service_role;

drop trigger if exists bookings_validate_schedule_consistency on public.bookings;
create trigger bookings_validate_schedule_consistency
before insert or update of start_time, end_time, total_duration_minutes on public.bookings
for each row execute function public.validate_booking_schedule_consistency();

create or replace function public.assert_booking_item_bundle()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_booking_id uuid;
  v_status text;
  v_store_count integer;
  v_visible_count integer;
  v_store_duration integer;
  v_invalid_store_count integer;
begin
  if tg_table_name = 'bookings' then
    v_booking_id := coalesce(new.id, old.id);
  else
    v_booking_id := coalesce(new.booking_id, old.booking_id);
  end if;

  select status into v_status
  from public.bookings
  where id = v_booking_id;

  if not found or v_status not in ('pending', 'confirmed') then
    return coalesce(new, old);
  end if;

  select duration_minutes into v_store_duration
  from public.booking_services
  where id = '00000000-0000-4000-8000-000000000010'::uuid
    and is_active = true
    and deleted_at is null;

  if not found then
    raise exception 'BOOKING_SERVICE_NOT_FOUND';
  end if;

  select
    count(*) filter (where service_id = '00000000-0000-4000-8000-000000000010'::uuid),
    count(*) filter (where service_id <> '00000000-0000-4000-8000-000000000010'::uuid),
    count(*) filter (
      where service_id = '00000000-0000-4000-8000-000000000010'::uuid
        and (quantity <> 1 or unit_duration_minutes <> v_store_duration)
    )
  into v_store_count, v_visible_count, v_invalid_store_count
  from public.booking_items
  where booking_id = v_booking_id;

  if v_store_count <> 1 or v_visible_count < 1 or v_invalid_store_count <> 0 then
    raise exception 'INVALID_BOOKING_ITEMS';
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function public.assert_booking_item_bundle() from public, anon, authenticated;
grant execute on function public.assert_booking_item_bundle() to service_role;

drop trigger if exists bookings_assert_item_bundle on public.bookings;
create constraint trigger bookings_assert_item_bundle
after insert or update on public.bookings
deferrable initially deferred
for each row execute function public.assert_booking_item_bundle();

drop trigger if exists booking_items_assert_bundle on public.booking_items;
create constraint trigger booking_items_assert_bundle
after insert or update or delete on public.booking_items
deferrable initially deferred
for each row execute function public.assert_booking_item_bundle();

create or replace function public.create_booking_request(
  p_request_id text,
  p_service_id uuid,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time without time zone,
  p_member_note text default ''
)
returns public.bookings
language plpgsql
security invoker
set search_path = public
as $$
begin
  return public.create_booking_bundle_request(
    p_request_id,
    p_member_id,
    p_booking_date,
    p_start_time,
    jsonb_build_array(
      jsonb_build_object('serviceId', p_service_id, 'quantity', 1),
      jsonb_build_object('serviceId', '00000000-0000-4000-8000-000000000010'::uuid, 'quantity', 1)
    ),
    p_member_note
  );
end;
$$;

revoke all on function public.create_booking_request(text, uuid, uuid, date, time without time zone, text) from public, anon, authenticated;
grant execute on function public.create_booking_request(text, uuid, uuid, date, time without time zone, text) to service_role;

commit;
