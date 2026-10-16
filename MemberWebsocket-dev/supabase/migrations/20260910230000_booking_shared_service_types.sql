-- Centralized booking service types.
-- Administrators maintain the allowed type list in booking shared settings;
-- booking services must reference one of those canonical names.

create table if not exists public.booking_service_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_service_types_name_check
    check (char_length(btrim(name)) between 1 and 80),
  constraint booking_service_types_sort_order_check
    check (sort_order between 0 and 1000)
);

create unique index if not exists booking_service_types_name_ci_key
  on public.booking_service_types (lower(btrim(name)));
create index if not exists booking_service_types_sort_order_idx
  on public.booking_service_types (sort_order, created_at);

alter table public.booking_service_types enable row level security;
revoke all on table public.booking_service_types from public, anon, authenticated;
grant select, insert, update, delete on table public.booking_service_types to service_role;

comment on table public.booking_service_types is
  'Administrator-managed canonical booking service types used by the booking service dropdown.';
comment on column public.booking_service_types.name is
  'Canonical service type label. Matching is case-insensitive and whitespace-trimmed.';

-- Preserve every already-configured user-facing service type as the initial shared list.
with existing_types as (
  select
    btrim(service_type) as name,
    min(created_at) as first_seen
  from public.booking_services
  where coalesce(counts_toward_membership, true) = true
    and service_type is not null
    and btrim(service_type) <> ''
  group by btrim(service_type)
)
insert into public.booking_service_types(name, sort_order)
select
  name,
  (row_number() over (order by first_seen, name) - 1)::integer
from existing_types
on conflict do nothing;

create or replace function public.save_booking_settings_with_service_types(
  p_work_start_time time without time zone,
  p_work_end_time time without time zone,
  p_min_advance_days integer,
  p_service_types text[],
  p_expected_updated_at timestamptz default null,
  p_actor text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_updated_at timestamptz;
  v_types text[] := coalesce(p_service_types, array[]::text[]);
begin
  select updated_at
    into v_current_updated_at
  from public.booking_settings
  where id = 1
  for update;

  if not found then
    raise exception 'BOOKING_SETTINGS_MISSING';
  end if;

  if p_expected_updated_at is not null and v_current_updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_SETTINGS_CONFLICT';
  end if;

  if p_work_end_time <= p_work_start_time
     or extract(epoch from (p_work_end_time - p_work_start_time)) < 1800 then
    raise exception 'INVALID_WORK_HOURS';
  end if;

  if p_min_advance_days < 0 or p_min_advance_days > 365 then
    raise exception 'INVALID_ADVANCE_DAYS';
  end if;

  if cardinality(v_types) > 50 then
    raise exception 'INVALID_SERVICE_TYPES';
  end if;

  if exists (
    select 1
    from unnest(v_types) as t(name)
    where char_length(btrim(name)) not between 1 and 80
  ) then
    raise exception 'INVALID_SERVICE_TYPES';
  end if;

  if exists (
    select 1
    from (
      select lower(btrim(name)) as normalized_name, count(*) as c
      from unnest(v_types) as t(name)
      group by lower(btrim(name))
      having count(*) > 1
    ) duplicated
  ) then
    raise exception 'DUPLICATE_SERVICE_TYPE';
  end if;

  if exists (
    select 1
    from public.booking_services service
    where coalesce(service.counts_toward_membership, true) = true
      and service.service_type is not null
      and btrim(service.service_type) <> ''
      and not exists (
        select 1
        from unnest(v_types) as t(name)
        where lower(btrim(name)) = lower(btrim(service.service_type))
      )
  ) then
    raise exception 'BOOKING_SERVICE_TYPE_IN_USE';
  end if;

  delete from public.booking_service_types;

  insert into public.booking_service_types(name, sort_order)
  select btrim(name), (ordinality - 1)::integer
  from unnest(v_types) with ordinality as t(name, ordinality)
  order by ordinality;

  update public.booking_settings
  set work_start_time = p_work_start_time,
      work_end_time = p_work_end_time,
      min_advance_days = p_min_advance_days,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = 1;
end;
$$;

revoke all on function public.save_booking_settings_with_service_types(
  time without time zone,
  time without time zone,
  integer,
  text[],
  timestamptz,
  text
) from public, anon, authenticated;
grant execute on function public.save_booking_settings_with_service_types(
  time without time zone,
  time without time zone,
  integer,
  text[],
  timestamptz,
  text
) to service_role;

-- Enforce the shared type list at the database boundary as defense in depth.
-- The existing compatibility trigger runs first (alphabetically) and converts
-- legacy __TYPE__: descriptions into service_type before this validation trigger.
create or replace function public.validate_booking_service_shared_type()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_canonical_name text;
begin
  if coalesce(new.counts_toward_membership, true) = false then
    return new;
  end if;

  if new.service_type is null or btrim(new.service_type) = '' then
    raise exception 'BOOKING_SERVICE_TYPE_REQUIRED';
  end if;

  select name
    into v_canonical_name
  from public.booking_service_types
  where lower(btrim(name)) = lower(btrim(new.service_type))
  limit 1;

  if not found then
    raise exception 'BOOKING_SERVICE_TYPE_INVALID';
  end if;

  new.service_type := v_canonical_name;
  return new;
end;
$$;

revoke all on function public.validate_booking_service_shared_type() from public, anon, authenticated;
grant execute on function public.validate_booking_service_shared_type() to service_role;

drop trigger if exists zz_booking_services_validate_shared_type on public.booking_services;
create trigger zz_booking_services_validate_shared_type
before insert or update of service_type, description, counts_toward_membership
on public.booking_services
for each row execute function public.validate_booking_service_shared_type();
