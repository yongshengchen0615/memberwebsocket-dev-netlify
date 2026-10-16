-- Configure one or more allowed snapshot locations, independent from ticket geofences.
-- Existing snapshot policy stays disabled until an admin explicitly enables it.
begin;

alter table public.booking_settings
  add column snapshot_locations jsonb not null default '[]'::jsonb;
alter table public.booking_settings
  add constraint booking_snapshot_locations_array check (jsonb_typeof(snapshot_locations) = 'array' and jsonb_array_length(snapshot_locations) <= 20);

create or replace function public.save_booking_shared_settings_v7(
 p_work_start_time time, p_work_end_time time, p_slot_interval_minutes integer,
 p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text,
 p_store_service_minutes integer, p_reminder_enabled boolean, p_reminder_time time,
 p_expected_updated_at timestamptz, p_actor text, p_snapshot_location_required boolean,
 p_ticket_booking_required boolean, p_snapshot_locations jsonb
) returns public.booking_settings language plpgsql security invoker set search_path = '' as $$
declare
  old_settings public.booking_settings%rowtype;
  result public.booking_settings%rowtype;
  loc jsonb;
  lat numeric;
  lng numeric;
  radius integer;
  label text;
begin
  select * into old_settings from public.booking_settings where id=1 for update;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  if p_snapshot_locations is null or jsonb_typeof(p_snapshot_locations) <> 'array'
     or jsonb_array_length(p_snapshot_locations) > 20 then
    raise exception 'SNAPSHOT_LOCATION_CONFIG_INVALID';
  end if;
  for loc in select value from jsonb_array_elements(p_snapshot_locations) loop
    if jsonb_typeof(loc) <> 'object'
       or jsonb_typeof(loc->'latitude') is distinct from 'number'
       or jsonb_typeof(loc->'longitude') is distinct from 'number'
       or jsonb_typeof(loc->'radiusMeters') is distinct from 'number'
       or jsonb_typeof(loc->'name') is distinct from 'string'
       then raise exception 'SNAPSHOT_LOCATION_CONFIG_INVALID'; end if;
    lat := (loc->>'latitude')::numeric;
    lng := (loc->>'longitude')::numeric;
    radius := (loc->>'radiusMeters')::integer;
    label := btrim(loc->>'name');
    if lat not between -90 and 90 or lng not between -180 and 180
       or radius not between 50 and 2000
       or (loc->>'radiusMeters')::numeric <> radius
       or length(label) not between 1 and 100
       then raise exception 'SNAPSHOT_LOCATION_CONFIG_INVALID'; end if;
  end loop;
  if coalesce(p_snapshot_location_required,old_settings.snapshot_location_required)
     and jsonb_array_length(p_snapshot_locations)=0 then
    raise exception 'SNAPSHOT_LOCATION_NOT_CONFIGURED';
  end if;
  -- This routine performs admin authorization, optimistic lock and all existing settings validation.
  perform public.save_booking_shared_settings_v6(
    p_work_start_time,p_work_end_time,p_slot_interval_minutes,
    p_min_advance_days,p_max_advance_days,p_booking_notice,p_store_service_minutes,
    p_reminder_enabled,p_reminder_time,p_expected_updated_at,p_actor,
    p_snapshot_location_required,p_ticket_booking_required
  );
  update public.booking_settings set snapshot_locations=p_snapshot_locations
  where id=1 returning * into result;
  if old_settings.snapshot_locations is distinct from result.snapshot_locations then
    insert into public.booking_audit_events
      (actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
    values (p_actor,'admin','SNAPSHOT_LOCATIONS_UPDATED','booking_settings','1','success',
      jsonb_build_object('beforeCount',jsonb_array_length(old_settings.snapshot_locations),
                         'afterCount',jsonb_array_length(result.snapshot_locations)));
  end if;
  return result;
end $$;

create or replace function public.require_snapshot_location(p_location jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare
  v_required boolean;
  v_locations jsonb;
  v_lat double precision;
  v_lng double precision;
  v_accuracy double precision;
  v_time numeric;
  loc jsonb;
  lat double precision;
  lng double precision;
  radius double precision;
  distance double precision;
begin
  -- Serialize location edits with receipt preparation and finalization.
  select snapshot_location_required,snapshot_locations into v_required,v_locations
    from public.booking_settings where id=1 for share;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  if not v_required then return; end if;
  if jsonb_typeof(v_locations) <> 'array' or jsonb_array_length(v_locations)=0 then
    raise exception 'SNAPSHOT_LOCATION_NOT_CONFIGURED';
  end if;
  if p_location is null or jsonb_typeof(p_location)<>'object'
     or jsonb_typeof(p_location->'latitude') is distinct from 'number'
     or jsonb_typeof(p_location->'longitude') is distinct from 'number'
     or jsonb_typeof(p_location->'accuracy') is distinct from 'number'
     or jsonb_typeof(p_location->'timestamp') is distinct from 'number'
     then raise exception 'SNAPSHOT_LOCATION_REQUIRED'; end if;
  v_lat := (p_location->>'latitude')::double precision;
  v_lng := (p_location->>'longitude')::double precision;
  v_accuracy := (p_location->>'accuracy')::double precision;
  v_time := (p_location->>'timestamp')::numeric;
  if not (v_lat between -90 and 90) or not (v_lng between -180 and 180)
     or not (v_accuracy between 0 and 2000)
     or v_time < extract(epoch from clock_timestamp())*1000-120000
     or v_time > extract(epoch from clock_timestamp())*1000+30000
     then raise exception 'SNAPSHOT_LOCATION_INVALID'; end if;
  for loc in select value from jsonb_array_elements(v_locations) loop
    lat := (loc->>'latitude')::double precision;
    lng := (loc->>'longitude')::double precision;
    radius := (loc->>'radiusMeters')::double precision;
    distance := 6371000.0*2.0*asin(sqrt(least(1.0,
      power(sin(radians(v_lat-lat)/2.0),2)
      +cos(radians(lat))*cos(radians(v_lat))
       *power(sin(radians(v_lng-lng)/2.0),2))));
    -- Reject inaccurate fixes rather than permitting a broad GPS accuracy
    -- circle to satisfy a small business-configured geofence.
    if distance <= radius and v_accuracy <= radius then return; end if;
  end loop;
  raise exception 'SNAPSHOT_LOCATION_OUT_OF_RANGE';
end $$;

revoke all on function public.save_booking_shared_settings_v7(time,time,integer,integer,integer,text,integer,boolean,time,timestamptz,text,boolean,boolean,jsonb)
  from public,anon,authenticated;
grant execute on function public.save_booking_shared_settings_v7(time,time,integer,integer,integer,text,integer,boolean,time,timestamptz,text,boolean,boolean,jsonb)
  to service_role;
revoke all on function public.require_snapshot_location(jsonb) from public,anon,authenticated;
grant execute on function public.require_snapshot_location(jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
