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
  -- A legacy admin client that omits the new field must not erase a saved number.
  if p_phone_booking_number is null then v_phone := v_original; end if;

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


-- Each merchant owns an independent business_<32hex> schema. Installing only
-- public settings would cause scoped Edge RPCs and reads to fail for merchants.
create or replace function platform_private.install_booking_phone_fallback(p_schema text)
returns void language plpgsql security definer set search_path = ''
as $installer$
declare
  v_function oid;
  v_definition text;
begin
  if p_schema !~ '^business_[0-9a-f]{32}$'
    or not exists (select 1 from platform_private.tenants t where t.runtime_schema = p_schema)
    or to_regclass(format('%I.booking_settings',p_schema)) is null
    or to_regclass(format('%I.booking_audit_events',p_schema)) is null
    or to_regprocedure(format('%I.save_booking_shared_settings_v7(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb)',p_schema)) is null
  then
    raise exception 'BOOKING_PHONE_TENANT_SCHEMA_INVALID';
  end if;

  execute format('alter table %I.booking_settings add column if not exists phone_booking_number text not null default ''''', p_schema);
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid=to_regclass(format('%I.booking_settings',p_schema))
      and conname='booking_settings_phone_booking_number_check'
  ) then
    execute format($constraint$
      alter table %1$I.booking_settings
      add constraint booking_settings_phone_booking_number_check
      check (
        phone_booking_number = ''
        or (
          char_length(phone_booking_number) <= 25
          and phone_booking_number ~ '^[+]?[0-9][0-9 ()-]{4,24}$'
          and length(regexp_replace(phone_booking_number, '[^0-9]', '', 'g')) between 6 and 15
        )
      )
    $constraint$,p_schema);
  end if;

  select p.oid into strict v_function
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='save_booking_shared_settings_v8';
  v_definition := pg_catalog.pg_get_functiondef(v_function);
  v_definition := replace(v_definition,'public.',format('%I.',p_schema));
  execute v_definition;
  execute format('revoke all on function %I.save_booking_shared_settings_v8(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text) from public,anon,authenticated',p_schema);
  execute format('grant execute on function %I.save_booking_shared_settings_v8(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text) to service_role',p_schema);
end;
$installer$;
revoke all on function platform_private.install_booking_phone_fallback(text) from public,anon,authenticated;
grant execute on function platform_private.install_booking_phone_fallback(text) to service_role;

-- Upgrade all existing tenants, and abort atomically if any tenant cannot be
-- upgraded. Never silently enable a fallback only for some businesses.
do $existing_tenants$
declare v record;
begin
  for v in select runtime_schema from platform_private.tenants where runtime_schema is not null
  loop
    perform platform_private.install_booking_phone_fallback(v.runtime_schema);
  end loop;
end;
$existing_tenants$;

-- Preserve the currently deployed provisioning chain, which includes all
-- pricing, invitation, reminder and tenant safeguards. The old function is
-- renamed rather than reconstructed from an outdated migration body.
alter function public.platform_provision_business(uuid)
  rename to platform_provision_business_before_booking_phone;
revoke all on function public.platform_provision_business_before_booking_phone(uuid) from public,anon,authenticated;
grant execute on function public.platform_provision_business_before_booking_phone(uuid) to service_role;

create function public.platform_provision_business(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = ''
as $provision$
declare v_schema text;
begin
  perform public.platform_provision_business_before_booking_phone(p_tenant_id);
  select runtime_schema into strict v_schema from platform_private.tenants where id=p_tenant_id;
  perform platform_private.install_booking_phone_fallback(v_schema);
end;
$provision$;
revoke all on function public.platform_provision_business(uuid) from public,anon,authenticated;
grant execute on function public.platform_provision_business(uuid) to service_role;

notify pgrst, 'reload schema';

