begin;

-- Display name changes retain submission_mode='accessible' and historical IDs.
-- Keep existing behavior until an authorized administrator enables this policy.
alter table public.booking_settings
  add column snapshot_location_required boolean not null default false;

create or replace function public.save_booking_shared_settings_v5(
  p_work_start_time time, p_work_end_time time, p_slot_interval_minutes integer,
  p_min_advance_days integer, p_max_advance_days integer, p_booking_notice text,
  p_store_service_minutes integer, p_reminder_enabled boolean, p_reminder_time time,
  p_expected_updated_at timestamptz, p_actor text, p_snapshot_location_required boolean
) returns public.booking_settings
language plpgsql security invoker set search_path = '' as $$
declare v_before public.booking_settings%rowtype; v_after public.booking_settings%rowtype;
begin
  select * into v_before from public.booking_settings where id=1 for update;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  -- v4/v3 validate the active administrator and stale version within this transaction.
  perform public.save_booking_shared_settings_v4(
    p_work_start_time,p_work_end_time,p_slot_interval_minutes,p_min_advance_days,
    p_max_advance_days,p_booking_notice,p_store_service_minutes,p_reminder_enabled,
    p_reminder_time,p_expected_updated_at,p_actor
  );
  update public.booking_settings set snapshot_location_required=
    coalesce(p_snapshot_location_required,v_before.snapshot_location_required)
    where id=1 returning * into v_after;
  if v_before.snapshot_location_required is distinct from v_after.snapshot_location_required then
    insert into public.booking_audit_events
      (actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
    values(p_actor,'admin','SNAPSHOT_LOCATION_POLICY_UPDATED','booking_settings','1','success',
      jsonb_build_object('before',v_before.snapshot_location_required,'after',v_after.snapshot_location_required));
  end if;
  return v_after;
end $$;

-- GPS is client-reported evidence, not proof of presence. Validate shape/freshness
-- without persisting precise coordinates or introducing a geofence.
create or replace function public.require_snapshot_location(p_location jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_required boolean; v_lat numeric; v_lng numeric; v_accuracy numeric; v_time numeric;
begin
  -- Serialize with policy updates until prepare/finalize commits.
  select snapshot_location_required into v_required from public.booking_settings where id=1 for share;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  if not v_required then return; end if;
  if p_location is null or jsonb_typeof(p_location)<>'object'
    or jsonb_typeof(p_location->'latitude') is distinct from 'number'
    or jsonb_typeof(p_location->'longitude') is distinct from 'number'
    or jsonb_typeof(p_location->'accuracy') is distinct from 'number'
    or jsonb_typeof(p_location->'timestamp') is distinct from 'number'
    then raise exception 'SNAPSHOT_LOCATION_REQUIRED'; end if;
  v_lat=(p_location->>'latitude')::numeric; v_lng=(p_location->>'longitude')::numeric;
  v_accuracy=(p_location->>'accuracy')::numeric; v_time=(p_location->>'timestamp')::numeric;
  if v_lat not between -90 and 90 or v_lng not between -180 and 180 or v_accuracy<0
    or v_time < extract(epoch from clock_timestamp())*1000-120000
    or v_time > extract(epoch from clock_timestamp())*1000+30000
    then raise exception 'SNAPSHOT_LOCATION_INVALID'; end if;
end $$;

create or replace function public.prepare_snapshot_receipt_request(
 p_member_id uuid,p_request_id text,p_object_path text,p_mime_type text,p_size_bytes integer,p_location jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
 perform public.require_snapshot_location(p_location);
 return public.prepare_accessible_receipt_request(p_member_id,p_request_id,p_object_path,p_mime_type,p_size_bytes);
end $$;

create or replace function public.finalize_snapshot_receipt_request(
 p_receipt_id text,p_member_id uuid,p_actor_line_user_id text,p_actual_mime_type text,
 p_actual_size_bytes integer,p_sha256_hex text,p_location jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
 -- Idempotent replay does not retroactively invalidate an already committed receipt.
 if not exists(select 1 from public.booking_receipts where receipt_id=p_receipt_id
   and member_id=p_member_id and submission_mode='accessible' and status in ('awaiting_review','bound')) then
   perform public.require_snapshot_location(p_location);
 end if;
 return public.finalize_accessible_receipt_request(p_receipt_id,p_member_id,p_actor_line_user_id,
   p_actual_mime_type,p_actual_size_bytes,p_sha256_hex);
end $$;

revoke all on function public.save_booking_shared_settings_v5(time,time,integer,integer,integer,text,integer,boolean,time,timestamptz,text,boolean) from public,anon,authenticated;
revoke all on function public.require_snapshot_location(jsonb) from public,anon,authenticated;
revoke all on function public.prepare_snapshot_receipt_request(uuid,text,text,text,integer,jsonb) from public,anon,authenticated;
revoke all on function public.finalize_snapshot_receipt_request(text,uuid,text,text,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_booking_shared_settings_v5(time,time,integer,integer,integer,text,integer,boolean,time,timestamptz,text,boolean) to service_role;
grant execute on function public.require_snapshot_location(jsonb) to service_role;
grant execute on function public.prepare_snapshot_receipt_request(uuid,text,text,text,integer,jsonb) to service_role;
grant execute on function public.finalize_snapshot_receipt_request(text,uuid,text,text,integer,text,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
