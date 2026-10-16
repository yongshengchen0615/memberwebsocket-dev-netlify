-- Booking service types are now managed by dedicated CRUD actions.
-- Keep the legacy RPC signature for cached admin clients, but make this RPC
-- responsible only for booking shared settings. This removes the old coupling
-- between saving work hours and replacing the entire service-type catalog.

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
begin
  select updated_at
    into v_current_updated_at
  from public.booking_settings
  where id = 1
  for update;

  if not found then
    raise exception 'BOOKING_SETTINGS_MISSING';
  end if;

  if p_expected_updated_at is not null
     and v_current_updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_SETTINGS_CONFLICT';
  end if;

  if p_work_end_time <= p_work_start_time
     or extract(epoch from (p_work_end_time - p_work_start_time)) < 1800 then
    raise exception 'INVALID_WORK_HOURS';
  end if;

  if p_min_advance_days < 0 or p_min_advance_days > 365 then
    raise exception 'INVALID_ADVANCE_DAYS';
  end if;

  update public.booking_settings
  set work_start_time = p_work_start_time,
      work_end_time = p_work_end_time,
      min_advance_days = p_min_advance_days,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = 1;

  -- p_service_types is intentionally ignored. Service types are managed by
  -- admin.booking.type.create/update/delete and must not be replaced here.
  perform p_service_types;
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

comment on function public.save_booking_settings_with_service_types(
  time without time zone,
  time without time zone,
  integer,
  text[],
  timestamptz,
  text
) is 'Compatibility RPC: saves only booking shared settings. Service types are managed by dedicated admin CRUD actions.';

-- Ensure PostgREST immediately sees the replaced routine definition.
notify pgrst, 'reload schema';
