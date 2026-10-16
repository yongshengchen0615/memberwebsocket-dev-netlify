-- Booking pricing: administrators set a TWD price per service and every new
-- booking item stores an immutable price snapshot. Existing booking history
-- remains at 0 because there is no trustworthy historical price to reconstruct.

alter table public.booking_services
  add column if not exists price_amount integer not null default 0;

alter table public.booking_services
  drop constraint if exists booking_services_price_amount_check;
alter table public.booking_services
  add constraint booking_services_price_amount_check
  check (price_amount between 0 and 10000000);

alter table public.booking_items
  add column if not exists unit_price_amount integer not null default 0;

alter table public.booking_items
  drop constraint if exists booking_items_unit_price_amount_check;
alter table public.booking_items
  add constraint booking_items_unit_price_amount_check
  check (unit_price_amount between 0 and 10000000);

comment on column public.booking_services.price_amount is
  'Current service price in whole TWD dollars. Server-side booking creation is authoritative.';
comment on column public.booking_items.unit_price_amount is
  'Price snapshot in whole TWD dollars captured when the booking item is created.';

create or replace function public.snapshot_booking_item_price()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_price integer;
begin
  select price_amount
    into v_price
  from public.booking_services
  where id = new.service_id;

  if not found then
    raise exception 'BOOKING_SERVICE_NOT_FOUND';
  end if;

  new.unit_price_amount := coalesce(v_price, 0);
  return new;
end;
$$;

revoke all on function public.snapshot_booking_item_price() from public, anon, authenticated;
grant execute on function public.snapshot_booking_item_price() to service_role;

drop trigger if exists booking_items_snapshot_price on public.booking_items;
create trigger booking_items_snapshot_price
before insert on public.booking_items
for each row execute function public.snapshot_booking_item_price();
