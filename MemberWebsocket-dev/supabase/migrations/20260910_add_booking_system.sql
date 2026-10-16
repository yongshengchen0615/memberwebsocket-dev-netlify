-- Booking system for MemberWebsocket-dev.
-- All booking data is server-only: browser clients must go through the booking-api Edge Function.

create extension if not exists pgcrypto;

create table if not exists public.booking_services (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 100),
  description text not null default '' check (char_length(description) <= 1000),
  work_start_time time without time zone not null,
  work_end_time time without time zone not null,
  slot_minutes integer not null default 30 check (slot_minutes = 30),
  min_advance_days integer not null default 0 check (min_advance_days between 0 and 365),
  available_weekdays smallint[] not null default array[0,1,2,3,4,5,6]::smallint[],
  is_active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_services_time_range_check check (work_end_time > work_start_time),
  constraint booking_services_start_boundary_check check (
    extract(second from work_start_time) = 0 and extract(minute from work_start_time)::integer in (0, 30)
  ),
  constraint booking_services_end_boundary_check check (
    extract(second from work_end_time) = 0 and extract(minute from work_end_time)::integer in (0, 30)
  ),
  constraint booking_services_weekdays_check check (
    cardinality(available_weekdays) between 1 and 7
    and available_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]
  )
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique check (char_length(request_id) between 12 and 100),
  service_id uuid not null references public.booking_services(id) on delete restrict,
  member_id uuid not null references public.members(id) on delete restrict,
  booking_date date not null,
  start_time time without time zone not null,
  end_time time without time zone not null,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected','cancelled')),
  member_note text not null default '' check (char_length(member_note) <= 500),
  admin_note text not null default '' check (char_length(admin_note) <= 500),
  confirmed_by text,
  confirmed_at timestamptz,
  rejected_by text,
  rejected_at timestamptz,
  cancelled_by text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_30_minute_check check (end_time = start_time + interval '30 minutes'),
  constraint bookings_start_boundary_check check (
    extract(second from start_time) = 0 and extract(minute from start_time)::integer in (0, 30)
  )
);

-- A pending request already occupies the slot. Rejection/cancellation releases it.
create unique index if not exists bookings_active_slot_unique
  on public.bookings(service_id, booking_date, start_time)
  where status in ('pending','confirmed');

create index if not exists bookings_member_upcoming_idx
  on public.bookings(member_id, booking_date desc, start_time desc);

create index if not exists bookings_admin_queue_idx
  on public.bookings(status, booking_date, start_time);

create table if not exists public.booking_audit_events (
  id bigint generated always as identity primary key,
  actor_line_user_id text not null,
  actor_role text not null check (actor_role in ('member','admin','system')),
  action text not null check (char_length(action) between 1 and 80),
  target_type text not null check (char_length(target_type) between 1 and 50),
  target_id text not null check (char_length(target_id) between 1 and 100),
  result text not null default 'success' check (result in ('success','failed')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists booking_audit_events_target_idx
  on public.booking_audit_events(target_type, target_id, created_at desc);

create or replace function public.touch_booking_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists booking_services_touch_updated_at on public.booking_services;
create trigger booking_services_touch_updated_at
before update on public.booking_services
for each row execute function public.touch_booking_updated_at();

drop trigger if exists bookings_touch_updated_at on public.bookings;
create trigger bookings_touch_updated_at
before update on public.bookings
for each row execute function public.touch_booking_updated_at();

-- Atomic server-side booking creation. It runs with the Edge Function's service_role privileges only.
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
declare
  v_service public.booking_services%rowtype;
  v_member public.members%rowtype;
  v_existing public.bookings%rowtype;
  v_booking public.bookings%rowtype;
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_local_time time := (now() at time zone 'Asia/Taipei')::time;
  v_end_time time;
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

  select * into v_service
  from public.booking_services
  where id = p_service_id
  for share;

  if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
  if not v_service.is_active then raise exception 'BOOKING_SERVICE_DISABLED'; end if;

  if extract(second from p_start_time) <> 0
     or extract(minute from p_start_time)::integer not in (0, 30) then
    raise exception 'INVALID_BOOKING_SLOT';
  end if;

  if not (extract(dow from p_booking_date)::smallint = any(v_service.available_weekdays)) then
    raise exception 'BOOKING_DAY_UNAVAILABLE';
  end if;

  if p_booking_date < v_today + v_service.min_advance_days then
    raise exception 'BOOKING_TOO_EARLY';
  end if;

  if p_booking_date = v_today and p_start_time <= v_local_time then
    raise exception 'BOOKING_TIME_PASSED';
  end if;

  v_end_time := p_start_time + interval '30 minutes';
  if p_start_time < v_service.work_start_time or v_end_time > v_service.work_end_time then
    raise exception 'INVALID_BOOKING_SLOT';
  end if;

  begin
    insert into public.bookings(
      request_id, service_id, member_id, booking_date, start_time, end_time, status, member_note
    ) values (
      btrim(p_request_id), p_service_id, p_member_id, p_booking_date, p_start_time, v_end_time,
      'pending', left(coalesce(p_member_note, ''), 500)
    )
    returning * into v_booking;
  exception
    when unique_violation then
      raise exception 'BOOKING_SLOT_TAKEN';
  end;

  return v_booking;
end;
$$;

alter table public.booking_services enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_audit_events enable row level security;

revoke all on table public.booking_services from anon, authenticated;
revoke all on table public.bookings from anon, authenticated;
revoke all on table public.booking_audit_events from anon, authenticated;
revoke execute on function public.create_booking_request(text, uuid, uuid, date, time without time zone, text) from public, anon, authenticated;
grant execute on function public.create_booking_request(text, uuid, uuid, date, time without time zone, text) to service_role;
