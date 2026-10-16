-- Booking service classification + one fixed 10-minute in-store service per booking.
-- The in-store service occupies appointment time but is explicitly excluded from
-- membership service-minute accounting and has no price.

alter table public.booking_services
  add column if not exists service_type text,
  add column if not exists counts_toward_membership boolean not null default true;

alter table public.booking_services
  drop constraint if exists booking_services_service_type_check;
alter table public.booking_services
  add constraint booking_services_service_type_check
  check (service_type is null or char_length(btrim(service_type)) between 1 and 80);

alter table public.booking_items
  add column if not exists service_type text,
  add column if not exists counts_toward_membership boolean not null default true;

alter table public.booking_items
  drop constraint if exists booking_items_service_type_check;
alter table public.booking_items
  add constraint booking_items_service_type_check
  check (service_type is null or char_length(btrim(service_type)) between 1 and 80);

comment on column public.booking_services.service_type is
  'Administrator-defined service type used to warn members when multiple selected services share a type.';
comment on column public.booking_services.counts_toward_membership is
  'Whether this service may count toward member accumulated paid service minutes. System in-store service is false.';
comment on column public.booking_items.counts_toward_membership is
  'Immutable booking-item snapshot. False items must never be included in member paid service-minute totals or tier progress.';

-- booking-api currently exposes the legacy description field. Keep a narrow
-- compatibility encoding until service_type is exposed directly by the API.
create or replace function public.sync_booking_service_type_compat()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if left(coalesce(new.description, ''), 9) = '__TYPE__:' then
    new.service_type := nullif(btrim(substr(new.description, 10)), '');
  end if;
  return new;
end;
$$;

revoke all on function public.sync_booking_service_type_compat() from public, anon, authenticated;
grant execute on function public.sync_booking_service_type_compat() to service_role;

drop trigger if exists booking_services_sync_type_compat on public.booking_services;
create trigger booking_services_sync_type_compat
before insert or update of description on public.booking_services
for each row execute function public.sync_booking_service_type_compat();

-- Snapshot type and membership-accounting semantics for booking history.
create or replace function public.snapshot_booking_item_classification()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_type text;
  v_counts boolean;
begin
  select service_type, counts_toward_membership
    into v_type, v_counts
  from public.booking_services
  where id = new.service_id;

  if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;

  new.service_type := v_type;
  new.counts_toward_membership := coalesce(v_counts, true);
  return new;
end;
$$;

revoke all on function public.snapshot_booking_item_classification() from public, anon, authenticated;
grant execute on function public.snapshot_booking_item_classification() to service_role;

drop trigger if exists booking_items_snapshot_classification on public.booking_items;
create trigger booking_items_snapshot_classification
before insert on public.booking_items
for each row execute function public.snapshot_booking_item_classification();

-- Stable internal service. Client UI adds this service exactly once to every
-- booking request; booking-api and the existing RPC therefore include its
-- 10 minutes in slot availability, overlap protection and booking end time.
insert into public.booking_services(
  id, title, description, service_type,
  work_start_time, work_end_time, slot_minutes, min_advance_days,
  available_weekdays, duration_minutes, price_amount,
  counts_toward_membership, is_active, created_by
) values (
  '00000000-0000-4000-8000-000000000010'::uuid,
  '店內服務（肩頸／龜苓膏／熱茶）',
  '__SYSTEM__:included-store-service',
  '店內招待',
  '09:00:00', '17:00:00', 30, 0,
  array[0,1,2,3,4,5,6]::smallint[], 10, 0,
  false, true, 'system'
)
on conflict (id) do update set
  title = excluded.title,
  description = excluded.description,
  service_type = excluded.service_type,
  duration_minutes = 10,
  price_amount = 0,
  counts_toward_membership = false,
  is_active = true;
