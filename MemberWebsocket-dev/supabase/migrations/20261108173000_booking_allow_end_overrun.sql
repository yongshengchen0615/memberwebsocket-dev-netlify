-- AC-001..006: optional service end-time overrun, default off.
-- The appointment must still START before closing, and all existing slot-step,
-- duration, date, collision and authorization checks stay in force.
alter table public.booking_settings
  add column if not exists allow_end_overrun boolean not null default false;

comment on column public.booking_settings.allow_end_overrun is
  'Allow an appointment starting during working hours to end after closing. Defaults to false.';

-- The original helper was IMMUTABLE. A per-business setting makes it STABLE;
-- leaving it IMMUTABLE would permit stale answers or misuse in expression indexes.
create or replace function public.booking_slot_fits(
  p_date date, p_time time without time zone, p_duration integer,
  p_open time without time zone, p_close time without time zone, p_step integer
)
returns boolean
language sql stable set search_path = 'public', 'pg_temp'
as $function$
  select coalesce(
    p_date is not null and p_time is not null and p_open is not null and p_close is not null
    and p_open <> p_close and p_duration between 1 and 1439
    and p_step between 5 and 120 and p_step % 5 = 0
    and extract(second from p_time) = 0
    and public.booking_slot_start_at(p_date,p_time,p_open,p_close) >= p_date + p_open
    and public.booking_slot_start_at(p_date,p_time,p_open,p_close)
      < p_date + p_close + case when p_close < p_open then interval '1 day' else interval '0 days' end
    and (
      coalesce((select allow_end_overrun from public.booking_settings where id=1),false)
      or public.booking_slot_start_at(p_date,p_time,p_open,p_close) + make_interval(mins => p_duration)
        <= p_date + p_close + case when p_close < p_open then interval '1 day' else interval '0 days' end
    )
    and (extract(epoch from (public.booking_slot_start_at(p_date,p_time,p_open,p_close)
      - (p_date + p_open)))::integer / 60) % p_step = 0,
    false
  )
$function$;

-- The existing v8 procedure performs admin authorization, validation, optimistic
-- revision checks and locked, transactional updates. Delegate to it, then write
-- the new policy in the same transaction. Keep v8 intact for old clients.
create or replace function public.save_booking_shared_settings_v9(
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
  p_phone_booking_number text,
  p_allow_end_overrun boolean
)
returns public.booking_settings
language plpgsql security invoker set search_path = ''
as $function$
declare
  v_before boolean;
  v_after boolean;
  v_saved public.booking_settings%rowtype;
begin
  select allow_end_overrun into v_before
  from public.booking_settings where id=1 for update;

  select * into v_saved from public.save_booking_shared_settings_v8(
    p_work_start_time, p_work_end_time, p_slot_interval_minutes,
    p_min_advance_days, p_max_advance_days, p_booking_notice,
    p_store_service_minutes, p_reminder_enabled, p_reminder_time,
    p_expected_updated_at, p_actor, p_snapshot_location_required,
    p_ticket_booking_required, p_snapshot_locations, p_phone_booking_number
  );

  v_after := coalesce(p_allow_end_overrun,v_before,false);
  update public.booking_settings
     set allow_end_overrun=v_after
     where id=1
     returning * into v_saved;

  if v_before is distinct from v_after then
    insert into public.booking_audit_events
      (actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
    values (p_actor,'admin','BOOKING_END_OVERRUN_POLICY_UPDATED',
      'booking_settings','1','success',
      jsonb_build_object('before',v_before,'after',v_after));
  end if;
  return v_saved;
end;
$function$;

revoke all on function public.save_booking_shared_settings_v9(
  time without time zone,time without time zone,integer,integer,integer,
  text,integer,boolean,time without time zone,timestamp with time zone,
  text,boolean,boolean,jsonb,text,boolean
) from public,anon,authenticated;
grant execute on function public.save_booking_shared_settings_v9(
  time without time zone,time without time zone,integer,integer,integer,
  text,integer,boolean,time without time zone,timestamp with time zone,
  text,boolean,boolean,jsonb,text,boolean
) to service_role;

-- Install the same schema-local checks and settings RPC in every merchant.
create or replace function platform_private.install_booking_end_overrun(p_schema text)
returns void language plpgsql security definer set search_path = ''
as $installer$
declare
  v_function oid;
  v_definition text;
  v_name text;
begin
  if p_schema !~ '^business_[0-9a-f]{32}$'
    or not exists (select 1 from platform_private.tenants t where t.runtime_schema=p_schema)
    or to_regclass(format('%I.booking_settings',p_schema)) is null
    or to_regprocedure(format('%I.save_booking_shared_settings_v8(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text)',p_schema)) is null
    or to_regprocedure(format('%I.booking_slot_fits(date,time without time zone,integer,time without time zone,time without time zone,integer)',p_schema)) is null
  then raise exception 'BOOKING_END_OVERRUN_TENANT_SCHEMA_INVALID';
  end if;

  execute format('alter table %I.booking_settings add column if not exists allow_end_overrun boolean not null default false',p_schema);

  foreach v_name in array array['booking_slot_fits','save_booking_shared_settings_v9']
  loop
    select p.oid into strict v_function
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=v_name;
    v_definition := pg_catalog.pg_get_functiondef(v_function);
    v_definition := replace(v_definition,'public.',format('%I.',p_schema));
    execute v_definition;
  end loop;

  execute format('revoke all on function %I.save_booking_shared_settings_v9(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text,boolean) from public,anon,authenticated',p_schema);
  execute format('grant execute on function %I.save_booking_shared_settings_v9(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text,boolean) to service_role',p_schema);
end;
$installer$;
revoke all on function platform_private.install_booking_end_overrun(text) from public,anon,authenticated;
grant execute on function platform_private.install_booking_end_overrun(text) to service_role;

do $existing_tenants$
declare v record;
begin
  for v in select runtime_schema from platform_private.tenants where runtime_schema is not null
  loop
    perform platform_private.install_booking_end_overrun(v.runtime_schema);
  end loop;
end;
$existing_tenants$;

-- Future merchant provisioning must install the policy after the existing chain.
alter function public.platform_provision_business(uuid)
  rename to platform_provision_business_before_booking_end_overrun;
revoke all on function public.platform_provision_business_before_booking_end_overrun(uuid)
  from public,anon,authenticated;
grant execute on function public.platform_provision_business_before_booking_end_overrun(uuid)
  to service_role;

create function public.platform_provision_business(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = ''
as $provision$
declare v_schema text;
begin
  perform public.platform_provision_business_before_booking_end_overrun(p_tenant_id);
  select runtime_schema into strict v_schema
  from platform_private.tenants where id=p_tenant_id;
  perform platform_private.install_booking_end_overrun(v_schema);
end;
$provision$;
revoke all on function public.platform_provision_business(uuid)
  from public,anon,authenticated;
grant execute on function public.platform_provision_business(uuid)
  to service_role;

notify pgrst, 'reload schema';
