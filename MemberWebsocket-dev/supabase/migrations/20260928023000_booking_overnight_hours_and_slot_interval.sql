-- Business dates remain the opening date. The generated local timestamps are
-- immutable snapshots of each booking, independent of later setting changes.
begin;

alter table public.booking_settings
  add column slot_interval_minutes integer not null default 30;
alter table public.booking_settings
  add constraint booking_settings_slot_interval_check
  check (slot_interval_minutes between 5 and 120 and slot_interval_minutes % 5 = 0);
alter table public.booking_settings drop constraint booking_settings_time_range_check;
alter table public.booking_settings add constraint booking_settings_time_range_check
  check (work_end_time <> work_start_time);
alter table public.booking_settings drop constraint booking_settings_start_boundary_check;
alter table public.booking_settings add constraint booking_settings_start_boundary_check
  check (extract(second from work_start_time) = 0 and extract(minute from work_start_time)::integer % 5 = 0);
alter table public.booking_settings drop constraint booking_settings_end_boundary_check;
alter table public.booking_settings add constraint booking_settings_end_boundary_check
  check (extract(second from work_end_time) = 0 and extract(minute from work_end_time)::integer % 5 = 0);

create function public.booking_slot_start_at(p_date date, p_time time, p_open time, p_close time)
returns timestamp without time zone language sql immutable strict set search_path = public, pg_temp
as $$ select p_date + p_time + case when p_close < p_open and p_time < p_close then interval '1 day' else interval '0 days' end $$;

create function public.booking_slot_fits(p_date date, p_time time, p_duration integer,
  p_open time, p_close time, p_step integer)
returns boolean language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(p_date is not null and p_time is not null and p_open is not null and p_close is not null
    and p_open <> p_close and p_duration between 1 and 1439 and p_step between 5 and 120
    and p_step % 5 = 0 and extract(second from p_time) = 0
    and public.booking_slot_start_at(p_date,p_time,p_open,p_close) >= p_date + p_open
    and public.booking_slot_start_at(p_date,p_time,p_open,p_close) + make_interval(mins => p_duration)
      <= p_date + p_close + case when p_close < p_open then interval '1 day' else interval '0 days' end
    and (extract(epoch from (public.booking_slot_start_at(p_date,p_time,p_open,p_close) - (p_date + p_open)))::integer / 60) % p_step = 0, false)
$$;
revoke all on function public.booking_slot_start_at(date,time,time,time) from public, anon, authenticated;
revoke all on function public.booking_slot_fits(date,time,integer,time,time,integer) from public, anon, authenticated;
grant execute on function public.booking_slot_start_at(date,time,time,time), public.booking_slot_fits(date,time,integer,time,time,integer) to service_role;

alter table public.bookings add column starts_next_day boolean not null default false;
alter table public.bookings add column start_at timestamp without time zone
  generated always as (booking_date + start_time + case when starts_next_day then interval '1 day' else interval '0 days' end) stored;
alter table public.bookings add column end_at timestamp without time zone
  generated always as (booking_date + start_time + case when starts_next_day then interval '1 day' else interval '0 days' end
    + make_interval(mins => total_duration_minutes)) stored;
alter table public.bookings drop constraint bookings_duration_match_check;
alter table public.bookings add constraint bookings_duration_match_check check (
  total_duration_minutes between 1 and 1439 and end_time <> start_time
  and ((extract(epoch from (end_time - start_time))::integer + 86400) % 86400) / 60 = total_duration_minutes
);

create function public.set_booking_start_day() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v public.booking_settings%rowtype;
begin
  select * into v from public.booking_settings where id = 1;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  new.starts_next_day := v.work_end_time < v.work_start_time and new.start_time < v.work_end_time;
  return new;
end $$;
revoke all on function public.set_booking_start_day() from public, anon, authenticated;
create trigger bookings_set_start_day before insert or update of booking_date,start_time on public.bookings
  for each row execute function public.set_booking_start_day();

create or replace function public.validate_booking_schedule_consistency() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.total_duration_minutes not between 1 and 1439
     or new.end_time <> (new.start_time + make_interval(mins => new.total_duration_minutes))::time then
    raise exception 'INVALID_BOOKING_DURATION';
  end if;
  return new;
end $$;

alter table public.booking_participant_reservations add column starts_next_day boolean not null default false;
alter table public.booking_participant_reservations add column start_at timestamp without time zone
  generated always as (booking_date + start_time + case when starts_next_day then interval '1 day' else interval '0 days' end) stored;
alter table public.booking_participant_reservations add column end_at timestamp without time zone
  generated always as (booking_date + end_time + case when starts_next_day then interval '1 day' else interval '0 days' end
    + case when end_time <= start_time then interval '1 day' else interval '0 days' end) stored;
alter table public.booking_participant_reservations drop constraint booking_participant_reservations_time_check;
alter table public.booking_participant_reservations add constraint booking_participant_reservations_time_check check (end_time <> start_time);

create function public.set_reservation_start_day() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_booking public.bookings%rowtype;
begin
  select * into v_booking from public.bookings where id = new.booking_id;
  if not found or new.booking_date <> v_booking.booking_date or new.start_time <> v_booking.start_time then
    raise exception 'INVALID_BOOKING_RESERVATION';
  end if;
  new.starts_next_day := v_booking.starts_next_day;
  return new;
end $$;
revoke all on function public.set_reservation_start_day() from public, anon, authenticated;
create trigger booking_reservations_set_start_day before insert or update of booking_date,start_time,booking_id
  on public.booking_participant_reservations for each row execute function public.set_reservation_start_day();

-- Excluding by timestamp without a business-date equality catches a competing
-- shift that opens on the following calendar day as well.
alter table public.bookings drop constraint bookings_no_active_technician_overlap;
alter table public.bookings add constraint bookings_no_active_technician_overlap
  exclude using gist (technician_id with =, tsrange(start_at,end_at,'[)') with &&)
  where (status in ('pending','confirmed') and party_size = 1);
alter table public.booking_participant_reservations drop constraint booking_participant_reservations_no_overlap;
alter table public.booking_participant_reservations add constraint booking_participant_reservations_no_overlap
  exclude using gist (technician_id with =, tsrange(start_at,end_at,'[)') with &&) where (is_active);

create function public.save_booking_shared_settings_v3(
  p_work_start_time time, p_work_end_time time, p_slot_interval_minutes integer,
  p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text,
  p_store_service_minutes integer, p_expected_updated_at timestamptz default null, p_actor text default null
) returns public.booking_settings language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_before public.booking_settings%rowtype;
  v_after public.booking_settings%rowtype;
  v_notice text := coalesce(p_booking_notice,'');
  v_store constant uuid := '00000000-0000-4000-8000-000000000010'::uuid;
begin
  if not exists (select 1 from public.admins where line_user_id = p_actor and role = 'admin' and status = 'active') then
    raise exception 'ADMIN_REQUIRED';
  end if;
  select * into v_before from public.booking_settings where id = 1 for update;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  if p_expected_updated_at is not null and v_before.updated_at <> p_expected_updated_at then raise exception 'BOOKING_SETTINGS_CONFLICT'; end if;
  if p_work_start_time is null or p_work_end_time is null or p_work_start_time = p_work_end_time
     or extract(second from p_work_start_time) <> 0 or extract(second from p_work_end_time) <> 0
     or extract(minute from p_work_start_time)::integer % 5 <> 0 or extract(minute from p_work_end_time)::integer % 5 <> 0 then
    raise exception 'INVALID_WORK_HOURS';
  end if;
  if p_slot_interval_minutes is null or p_slot_interval_minutes not between 5 and 120 or p_slot_interval_minutes % 5 <> 0 then
    raise exception 'INVALID_SLOT_INTERVAL';
  end if;
  if p_min_advance_days is null or p_min_advance_days not between 0 and 365 then raise exception 'INVALID_ADVANCE_DAYS'; end if;
  if p_max_advance_days is null or p_max_advance_days not between 0 and 365 then raise exception 'INVALID_MAX_ADVANCE_DAYS'; end if;
  if p_max_advance_days > 0 and p_max_advance_days < p_min_advance_days then raise exception 'INVALID_ADVANCE_WINDOW'; end if;
  if char_length(v_notice) > 2000 then raise exception 'INVALID_BOOKING_NOTICE'; end if;
  if p_store_service_minutes is null or p_store_service_minutes not between 1 and 720 then raise exception 'INVALID_STORE_SERVICE_MINUTES'; end if;
  perform 1 from public.booking_services where id = v_store and deleted_at is null for update;
  if not found then raise exception 'BOOKING_STORE_SERVICE_MISSING'; end if;

  update public.booking_settings set work_start_time = p_work_start_time, work_end_time = p_work_end_time,
    slot_interval_minutes = p_slot_interval_minutes, min_advance_days = p_min_advance_days,
    max_advance_days = p_max_advance_days, booking_notice = v_notice,
    updated_by = nullif(btrim(coalesce(p_actor,'')),'') where id = 1 returning * into v_after;
  update public.booking_services set duration_minutes = p_store_service_minutes, updated_at = clock_timestamp()
    where id = v_store and deleted_at is null;

  insert into public.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
    values (nullif(btrim(coalesce(p_actor,'')),''),'admin','BOOKING_SETTINGS_UPDATED','booking_settings','1','success',
      jsonb_build_object('before',jsonb_build_object('workStartTime',v_before.work_start_time,'workEndTime',v_before.work_end_time,
        'slotIntervalMinutes',v_before.slot_interval_minutes,'minAdvanceDays',v_before.min_advance_days,'maxAdvanceDays',v_before.max_advance_days),
        'after',jsonb_build_object('workStartTime',v_after.work_start_time,'workEndTime',v_after.work_end_time,
        'slotIntervalMinutes',v_after.slot_interval_minutes,'minAdvanceDays',v_after.min_advance_days,'maxAdvanceDays',v_after.max_advance_days)));
  return v_after;
end $$;
revoke all on function public.save_booking_shared_settings_v3(time,time,integer,integer,integer,text,integer,timestamptz,text)
  from public,anon,authenticated;
grant execute on function public.save_booking_shared_settings_v3(time,time,integer,integer,integer,text,integer,timestamptz,text)
  to service_role;

-- These legacy RPCs still own create/update. Rewrite only their old time guards,
-- asserting every expected source pattern so schema drift fails the migration.
do $migration$
declare
  v_name text;
  v_signature regprocedure;
  v_def text;
  v_next text;
  v_old text;
begin
  foreach v_name in array array[
    'create_booking_bundle_request','update_booking_bundle_request',
    'create_group_booking_request','update_group_booking_request'
  ] loop
    select p.oid::regprocedure into v_signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name;
    if not found then raise exception 'MISSING_BOOKING_RPC: %',v_name; end if;
    v_def := pg_get_functiondef(v_signature);
    v_next := regexp_replace(v_def,
      'if extract\(second from p_start_time\) <> 0\s+or extract\(minute from p_start_time\)::integer not in \(0,\s*30\) then\s+raise exception ''INVALID_BOOKING_SLOT'';\s+end if;',
      'if extract(second from p_start_time) <> 0 then raise exception ''INVALID_BOOKING_SLOT''; end if;');
    if v_next = v_def then raise exception 'BOOKING_RPC_SLOT_GUARD_CHANGED: %',v_name; end if;
    v_def := v_next;
    v_next := regexp_replace(v_def,
      'if v_end_time <= p_start_time\s+or p_start_time < v_settings.work_start_time\s+or v_end_time > v_settings.work_end_time then',
      'if not public.booking_slot_fits(p_booking_date,p_start_time,v_total_duration,v_settings.work_start_time,v_settings.work_end_time,v_settings.slot_interval_minutes) then');
    if v_next = v_def then raise exception 'BOOKING_RPC_WORK_GUARD_CHANGED: %',v_name; end if;
    v_def := v_next;
    v_old := 'if p_booking_date = v_today and p_start_time <= v_local_time then';
    v_next := replace(v_def,v_old,
      'if public.booking_slot_start_at(p_booking_date,p_start_time,v_settings.work_start_time,v_settings.work_end_time) <= (clock_timestamp() at time zone ''Asia/Taipei'') then');
    if v_next = v_def then raise exception 'BOOKING_RPC_CLOCK_GUARD_CHANGED: %',v_name; end if;
    execute v_next;
  end loop;

  foreach v_name in array array['admin_update_booking_items_request','admin_update_booking_participant_items_request'] loop
    select p.oid::regprocedure into v_signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=v_name;
    if not found then raise exception 'MISSING_BOOKING_ADMIN_RPC: %',v_name; end if;
    v_def := pg_get_functiondef(v_signature);
    if v_name='admin_update_booking_items_request' then
      v_next := regexp_replace(v_def,
        'if v_end_time <= v_booking.start_time\s+or v_booking.start_time < v_settings.work_start_time\s+or v_end_time > v_settings.work_end_time then',
        'if not public.booking_slot_fits(v_booking.booking_date,v_booking.start_time,v_total_duration,v_settings.work_start_time,v_settings.work_end_time,v_settings.slot_interval_minutes) then');
    else
      v_next := replace(v_def,
        'if minutes < 1 or b.start_time + make_interval(mins => minutes) <= b.start_time then',
        'if minutes < 1 or minutes >= 1440 then');
      if v_next = v_def then raise exception 'BOOKING_ADMIN_DURATION_GUARD_CHANGED'; end if;
      v_def := v_next;
      v_next := replace(v_def,
        'if end_at <= b.start_time or b.start_time < cfg.work_start_time or end_at > cfg.work_end_time then',
        'if not public.booking_slot_fits(b.booking_date,b.start_time,total_minutes,cfg.work_start_time,cfg.work_end_time,cfg.slot_interval_minutes) then');
    end if;
    if v_next = v_def then raise exception 'BOOKING_ADMIN_WORK_GUARD_CHANGED: %',v_name; end if;
    execute v_next;
  end loop;
end $migration$;

notify pgrst, 'reload schema';
commit;
