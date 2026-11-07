-- Optional merchant phone number shown only when the selected date is outside
-- the online booking advance window. No member booking is created by this fallback.
alter table public.booking_settings
  add column if not exists phone_booking_number text not null default '';

alter table public.booking_settings
  add constraint booking_settings_phone_booking_number_check
  check (
    phone_booking_number = ''
    or (
      char_length(phone_booking_number) <= 25
      and phone_booking_number ~ '^[+]?[0-9][0-9 ()-]{4,24}$'
      and length(regexp_replace(phone_booking_number, '[^0-9]', '', 'g')) between 6 and 15
    )
  );

comment on column public.booking_settings.phone_booking_number is
  'Optional shop phone number for manual telephone booking outside the online advance-day window.';

-- v7 retains its existing contract so existing callers continue to work.
-- This wrapper delegates permission, optimistic lock, and settings validation to v7.
-- Both writes occur in one transaction and on the same locked settings row.
create or replace function public.save_booking_shared_settings_v8(
  p_work_start_time time without time zone,
  p_work_end_time time without time zone,
  p_slot_interval_minutes integer,
  p_min_advance_days integer,
  p_max_advance_days integer,
  p_booking_notice text,
  p_store_service_minutes integer,
  p_reminder_enabled boolean,
  p_reminder_time time without time zone,
  p_expected_updated_at timestamp with time zone,
  p_actor text,
  p_snapshot_location_required boolean,
  p_ticket_booking_required boolean,
  p_snapshot_locations jsonb,
  p_phone_booking_number text
)
returns public.booking_settings
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_original text;
  v_phone text := btrim(coalesce(p_phone_booking_number, ''));
  v_saved public.booking_settings%rowtype;
begin
  if v_phone <> '' and (
    char_length(v_phone) > 25
    or v_phone !~ '^[+]?[0-9][0-9 ()-]{4,24}$'
    or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 6 and 15
  ) then
    raise exception 'INVALID_PHONE_BOOKING_NUMBER';
  end if;

  select phone_booking_number into v_original
  from public.booking_settings where id = 1 for update;

  select * into v_saved
  from public.save_booking_shared_settings_v7(
    p_work_start_time, p_work_end_time, p_slot_interval_minutes,
    p_min_advance_days, p_max_advance_days, p_booking_notice,
    p_store_service_minutes, p_reminder_enabled, p_reminder_time,
    p_expected_updated_at, p_actor, p_snapshot_location_required,
    p_ticket_booking_required, p_snapshot_locations
  );

  update public.booking_settings
  set phone_booking_number = v_phone
  where id = 1
  returning * into v_saved;

  if v_original is distinct from v_phone then
    insert into public.booking_audit_events
      (actor_line_user_id, actor_role, action, target_type, target_id, result, metadata)
    values (
      p_actor, 'admin', 'PHONE_BOOKING_NUMBER_UPDATED',
      'booking_settings', '1', 'success',
      jsonb_build_object('configured', v_phone <> '')
    );
  end if;
  return v_saved;
end;
$function$;

revoke all on function public.save_booking_shared_settings_v8(
  time without time zone, time without time zone, integer, integer, integer,
  text, integer, boolean, time without time zone, timestamp with time zone,
  text, boolean, boolean, jsonb, text
) from public, anon, authenticated;
grant execute on function public.save_booking_shared_settings_v8(
  time without time zone, time without time zone, integer, integer, integer,
  text, integer, boolean, time without time zone, timestamp with time zone,
  text, boolean, boolean, jsonb, text
) to service_role;

notify pgrst, 'reload schema';
