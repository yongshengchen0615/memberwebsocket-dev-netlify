-- Booking v2: global working hours, per-service duration, multi-service appointments,
-- interval overlap protection, and transactional realtime invalidation.
-- Existing booking rows are preserved and migrated to one booking item each.

create extension if not exists btree_gist;

create table if not exists public.booking_settings (
  id smallint primary key default 1 check (id = 1),
  work_start_time time without time zone not null default '09:00:00',
  work_end_time time without time zone not null default '17:00:00',
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint booking_settings_time_range_check check (work_end_time > work_start_time),
  constraint booking_settings_start_boundary_check check (
    extract(second from work_start_time) = 0 and extract(minute from work_start_time)::integer in (0, 30)
  ),
  constraint booking_settings_end_boundary_check check (
    extract(second from work_end_time) = 0 and extract(minute from work_end_time)::integer in (0, 30)
  )
);

insert into public.booking_settings(id, work_start_time, work_end_time, updated_by)
select 1, s.work_start_time, s.work_end_time, s.created_by
from public.booking_services s
order by s.created_at
limit 1
on conflict (id) do nothing;

insert into public.booking_settings(id)
values (1)
on conflict (id) do nothing;

alter table public.booking_services
  add column if not exists duration_minutes integer not null default 30;

alter table public.booking_services
  drop constraint if exists booking_services_duration_minutes_check;
alter table public.booking_services
  add constraint booking_services_duration_minutes_check
  check (duration_minutes between 1 and 720);

-- Legacy per-service work-hour/week-day columns are retained for backward
-- compatibility, but Booking v2 no longer uses them for availability decisions.
alter table public.booking_services
  alter column work_start_time set default '09:00:00',
  alter column work_end_time set default '17:00:00',
  alter column available_weekdays set default array[0,1,2,3,4,5,6]::smallint[];

alter table public.bookings
  add column if not exists total_duration_minutes integer not null default 30;

alter table public.bookings
  drop constraint if exists bookings_30_minute_check;
alter table public.bookings
  drop constraint if exists bookings_duration_match_check;
alter table public.bookings
  add constraint bookings_duration_match_check check (
    total_duration_minutes between 1 and 1440
    and end_time > start_time
    and (extract(epoch from (end_time - start_time)) / 60)::integer = total_duration_minutes
  );

create table if not exists public.booking_items (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  service_id uuid not null references public.booking_services(id) on delete restrict,
  service_title text not null check (char_length(btrim(service_title)) between 1 and 100),
  unit_duration_minutes integer not null check (unit_duration_minutes between 1 and 720),
  quantity smallint not null default 1 check (quantity between 1 and 2),
  created_at timestamptz not null default now(),
  constraint booking_items_booking_service_unique unique (booking_id, service_id)
);

insert into public.booking_items(
  booking_id, service_id, service_title, unit_duration_minutes, quantity
)
select
  b.id,
  b.service_id,
  coalesce(nullif(btrim(s.title), ''), '預約項目'),
  greatest(1, b.total_duration_minutes),
  1
from public.bookings b
join public.booking_services s on s.id = b.service_id
where not exists (
  select 1 from public.booking_items bi where bi.booking_id = b.id
);

create index if not exists booking_items_booking_idx
  on public.booking_items(booking_id);
create index if not exists booking_items_service_idx
  on public.booking_items(service_id);

-- The old unique index only protected an identical service/start pair. It does
-- not protect overlapping durations or different services, so replace it with
-- one exclusion constraint for the administrator's whole schedule.
drop index if exists public.bookings_active_slot_unique;
alter table public.bookings
  drop constraint if exists bookings_no_active_overlap;
alter table public.bookings
  add constraint bookings_no_active_overlap
  exclude using gist (
    booking_date with =,
    tsrange(booking_date + start_time, booking_date + end_time, '[)') with &&
  )
  where (status in ('pending', 'confirmed'));

create or replace function public.touch_booking_settings_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists booking_settings_touch_updated_at on public.booking_settings;
create trigger booking_settings_touch_updated_at
before update on public.booking_settings
for each row execute function public.touch_booking_settings_updated_at();

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
  v_max_advance_days integer := 0;
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
    v_max_advance_days := greatest(v_max_advance_days, v_service.min_advance_days);
  end loop;

  if v_total_duration < 1 or v_total_duration > 1440 then raise exception 'INVALID_BOOKING_DURATION'; end if;
  if p_booking_date < v_today + v_max_advance_days then raise exception 'BOOKING_TOO_EARLY'; end if;
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

  -- Serialize creation attempts for the same day, then rely on the exclusion
  -- constraint as the final database-enforced overlap boundary.
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

alter table public.booking_settings enable row level security;
alter table public.booking_items enable row level security;
revoke all on table public.booking_settings from anon, authenticated;
revoke all on table public.booking_items from anon, authenticated;

-- Realtime rows contain only a scope + event type, never member PII. Clients
-- receive the signal and refetch through the authenticated booking API.
create or replace function public.notify_booking_realtime_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.emit_realtime_invalidation(
    array['member', 'admin'],
    'booking.db.' || tg_table_name || '.' || lower(tg_op)
  );
  return null;
end;
$$;

revoke all on function public.notify_booking_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_booking_realtime_change() to service_role;

drop trigger if exists realtime_booking_settings_change on public.booking_settings;
create trigger realtime_booking_settings_change
after insert or update or delete on public.booking_settings
for each statement execute function public.notify_booking_realtime_change();

drop trigger if exists realtime_booking_services_change on public.booking_services;
create trigger realtime_booking_services_change
after insert or update or delete on public.booking_services
for each statement execute function public.notify_booking_realtime_change();

drop trigger if exists realtime_bookings_change on public.bookings;
create trigger realtime_bookings_change
after insert or update or delete on public.bookings
for each statement execute function public.notify_booking_realtime_change();
