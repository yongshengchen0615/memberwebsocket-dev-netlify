-- AC-MIN-001..008: numeric end-of-workday grace period (0 = none).
-- Backfill old opted-in merchants to 1439 for backward compatibility; otherwise 0.
alter table public.booking_settings
 add column if not exists max_end_overrun_minutes integer not null default 0;
alter table public.booking_settings
 add constraint booking_settings_max_end_overrun_minutes_range
 check (max_end_overrun_minutes between 0 and 1439);
update public.booking_settings set max_end_overrun_minutes = 1439 where allow_end_overrun = true;
comment on column public.booking_settings.max_end_overrun_minutes is
 'Maximum service finish overrun in minutes; zero forbids ending after closing.';

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
    and public.booking_slot_start_at(p_date,p_time,p_open,p_close) + make_interval(mins => p_duration)
      < p_date + interval '2 days'
    and public.booking_slot_start_at(p_date,p_time,p_open,p_close) + make_interval(mins => p_duration)
      <= p_date + p_close + case when p_close < p_open then interval '1 day' else interval '0 days' end
      + make_interval(mins => coalesce(
        (select max_end_overrun_minutes from public.booking_settings where id = 1), 0
      ))
    and (extract(epoch from (public.booking_slot_start_at(p_date,p_time,p_open,p_close)
      - (p_date + p_open)))::integer / 60) % p_step = 0,
    false
  )
$function$;

-- v9 owns permission checks, optimistic concurrency and other shared fields.
-- Its boolean field is set to (minutes > 0) for old-client compatibility.
create or replace function public.save_booking_shared_settings_v10(
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
  p_max_end_overrun_minutes integer
)
returns public.booking_settings
language plpgsql security invoker set search_path = ''
as $function$
declare
 v_before integer;
 v_saved public.booking_settings%rowtype;
begin
 if p_max_end_overrun_minutes is not null
   and (p_max_end_overrun_minutes < 0 or p_max_end_overrun_minutes > 1439)
 then raise exception 'INVALID_BOOKING_END_OVERRUN_MINUTES' using errcode='22023';
 end if;
 select max_end_overrun_minutes into v_before
   from public.booking_settings where id=1 for update;
 select * into v_saved from public.save_booking_shared_settings_v9(
   p_work_start_time, p_work_end_time, p_slot_interval_minutes,
   p_min_advance_days, p_max_advance_days, p_booking_notice,
   p_store_service_minutes, p_reminder_enabled, p_reminder_time,
   p_expected_updated_at, p_actor, p_snapshot_location_required,
   p_ticket_booking_required, p_snapshot_locations, p_phone_booking_number,
   case when p_max_end_overrun_minutes is null then null else p_max_end_overrun_minutes > 0 end
 );
 update public.booking_settings
   set max_end_overrun_minutes = coalesce(p_max_end_overrun_minutes,v_before,0)
   where id=1 returning * into v_saved;
 if v_before is distinct from v_saved.max_end_overrun_minutes then
   insert into public.booking_audit_events
     (actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
   values (p_actor,'admin','BOOKING_END_OVERRUN_MINUTES_UPDATED',
     'booking_settings','1','success',
     jsonb_build_object('before',v_before,'after',v_saved.max_end_overrun_minutes));
 end if;
 return v_saved;
end;
$function$;
revoke all on function public.save_booking_shared_settings_v10(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text,integer)
 from public,anon,authenticated;
grant execute on function public.save_booking_shared_settings_v10(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text,integer) to service_role;

-- Replicate schema-local policy for every merchant, old and newly provisioned.
create or replace function platform_private.install_booking_end_overrun_minutes(p_schema text)
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
   or to_regprocedure(format('%I.save_booking_shared_settings_v9(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text,boolean)',p_schema)) is null
   or to_regprocedure(format('%I.booking_slot_fits(date,time without time zone,integer,time without time zone,time without time zone,integer)',p_schema)) is null
 then raise exception 'BOOKING_END_OVERRUN_TENANT_SCHEMA_INVALID';
 end if;
 execute format('alter table %I.booking_settings add column if not exists max_end_overrun_minutes integer not null default 0',p_schema);
 execute format('alter table %I.booking_settings add constraint booking_settings_max_end_overrun_minutes_range check (max_end_overrun_minutes between 0 and 1439)',p_schema);
 execute format('update %I.booking_settings set max_end_overrun_minutes = 1439 where allow_end_overrun = true',p_schema);
 foreach v_name in array array['booking_slot_fits','save_booking_shared_settings_v10']
 loop
   select p.oid into strict v_function
   from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname=v_name;
   v_definition := pg_catalog.pg_get_functiondef(v_function);
   v_definition := replace(v_definition,'public.',format('%I.',p_schema));
   execute v_definition;
 end loop;
 execute format('revoke all on function %I.save_booking_shared_settings_v10(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text,integer) from public,anon,authenticated',p_schema);
 execute format('grant execute on function %I.save_booking_shared_settings_v10(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text,integer) to service_role',p_schema);
end;
$installer$;
revoke all on function platform_private.install_booking_end_overrun_minutes(text) from public,anon,authenticated;
grant execute on function platform_private.install_booking_end_overrun_minutes(text) to service_role;

do $existing_tenants$
declare v record;
begin
 for v in select runtime_schema from platform_private.tenants where runtime_schema is not null
 loop perform platform_private.install_booking_end_overrun_minutes(v.runtime_schema);
 end loop;
end;
$existing_tenants$;

alter function public.platform_provision_business(uuid)
 rename to platform_provision_business_before_booking_end_overrun_minutes;
revoke all on function public.platform_provision_business_before_booking_end_overrun_minutes(uuid)
 from public,anon,authenticated;
grant execute on function public.platform_provision_business_before_booking_end_overrun_minutes(uuid)
 to service_role;
create function public.platform_provision_business(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = ''
as $provision$
declare v_schema text;
begin
 perform public.platform_provision_business_before_booking_end_overrun_minutes(p_tenant_id);
 select runtime_schema into strict v_schema
   from platform_private.tenants where id=p_tenant_id;
 perform platform_private.install_booking_end_overrun_minutes(v_schema);
end;
$provision$;
revoke all on function public.platform_provision_business(uuid)
 from public,anon,authenticated;
grant execute on function public.platform_provision_business(uuid)
 to service_role;
notify pgrst, 'reload schema';
