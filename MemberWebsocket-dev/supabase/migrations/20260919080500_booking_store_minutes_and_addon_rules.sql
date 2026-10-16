alter table public.booking_services
  add column if not exists requires_companion_service boolean not null default false;

comment on column public.booking_services.requires_companion_service is
  'When true, this service is an add-on and cannot be the only non-system service selected by one booking participant.';

create or replace function public.save_booking_shared_settings_v2(
  p_work_start_time time without time zone,
  p_work_end_time time without time zone,
  p_min_advance_days integer,
  p_max_advance_days integer,
  p_booking_notice text,
  p_store_service_minutes integer,
  p_expected_updated_at timestamp with time zone default null,
  p_actor text default null
)
returns public.booking_settings
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_current public.booking_settings%rowtype;
  v_saved public.booking_settings%rowtype;
  v_notice text := coalesce(p_booking_notice, '');
  v_store_id constant uuid := '00000000-0000-4000-8000-000000000010'::uuid;
begin
  select * into v_current from public.booking_settings where id = 1 for update;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  if p_expected_updated_at is not null and v_current.updated_at <> p_expected_updated_at then raise exception 'BOOKING_SETTINGS_CONFLICT'; end if;
  if p_work_start_time is null or p_work_end_time is null or p_work_end_time <= p_work_start_time
     or p_work_end_time - p_work_start_time < interval '30 minutes' then raise exception 'INVALID_WORK_HOURS'; end if;
  if p_min_advance_days is null or p_min_advance_days < 0 or p_min_advance_days > 365 then raise exception 'INVALID_ADVANCE_DAYS'; end if;
  if p_max_advance_days is null or p_max_advance_days < 0 or p_max_advance_days > 365 then raise exception 'INVALID_MAX_ADVANCE_DAYS'; end if;
  if p_max_advance_days > 0 and p_max_advance_days < p_min_advance_days then raise exception 'INVALID_ADVANCE_WINDOW'; end if;
  if char_length(v_notice) > 2000 then raise exception 'INVALID_BOOKING_NOTICE'; end if;
  if p_store_service_minutes is null or p_store_service_minutes < 1 or p_store_service_minutes > 720 then raise exception 'INVALID_STORE_SERVICE_MINUTES'; end if;

  perform 1 from public.booking_services where id = v_store_id and deleted_at is null for update;
  if not found then raise exception 'BOOKING_STORE_SERVICE_MISSING'; end if;

  update public.booking_settings
  set work_start_time = p_work_start_time,
      work_end_time = p_work_end_time,
      min_advance_days = p_min_advance_days,
      max_advance_days = p_max_advance_days,
      booking_notice = v_notice,
      updated_by = nullif(btrim(coalesce(p_actor, '')), '')
  where id = 1
  returning * into v_saved;

  update public.booking_services
  set duration_minutes = p_store_service_minutes,
      updated_at = now()
  where id = v_store_id and deleted_at is null;

  return v_saved;
end;
$function$;

revoke all on function public.save_booking_shared_settings_v2(
  time without time zone, time without time zone, integer, integer, text, integer, timestamp with time zone, text
) from public, anon, authenticated;
grant execute on function public.save_booking_shared_settings_v2(
  time without time zone, time without time zone, integer, integer, text, integer, timestamp with time zone, text
) to service_role;

create or replace function public.enforce_booking_participant_addon_companion()
returns trigger
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_participant_id uuid := coalesce(new.participant_id, old.participant_id);
  v_has_addon boolean := false;
  v_has_regular boolean := false;
begin
  if v_participant_id is null
     or not exists (select 1 from public.booking_participants where id = v_participant_id) then
    return null;
  end if;

  select coalesce(bool_or(s.requires_companion_service), false),
         coalesce(bool_or(not s.requires_companion_service), false)
  into v_has_addon, v_has_regular
  from public.booking_participant_items i
  join public.booking_services s on s.id = i.service_id
  where i.participant_id = v_participant_id
    and i.service_id <> '00000000-0000-4000-8000-000000000010'::uuid;

  if v_has_addon and not v_has_regular then raise exception 'BOOKING_ADD_ON_REQUIRES_COMPANION'; end if;
  return null;
end;
$function$;

revoke all on function public.enforce_booking_participant_addon_companion() from public, anon, authenticated;

drop trigger if exists booking_participant_items_addon_companion_guard on public.booking_participant_items;
create constraint trigger booking_participant_items_addon_companion_guard
after insert or update or delete on public.booking_participant_items
deferrable initially deferred
for each row execute function public.enforce_booking_participant_addon_companion();

create or replace function public.enforce_booking_addon_companion()
returns trigger
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  v_booking_id uuid := coalesce(new.booking_id, old.booking_id);
  v_has_addon boolean := false;
  v_has_regular boolean := false;
begin
  if v_booking_id is null
     or not exists (select 1 from public.bookings where id = v_booking_id)
     or exists (select 1 from public.booking_participants where booking_id = v_booking_id) then
    return null;
  end if;

  select coalesce(bool_or(s.requires_companion_service), false),
         coalesce(bool_or(not s.requires_companion_service), false)
  into v_has_addon, v_has_regular
  from public.booking_items i
  join public.booking_services s on s.id = i.service_id
  where i.booking_id = v_booking_id
    and i.service_id <> '00000000-0000-4000-8000-000000000010'::uuid;

  if v_has_addon and not v_has_regular then raise exception 'BOOKING_ADD_ON_REQUIRES_COMPANION'; end if;
  return null;
end;
$function$;

revoke all on function public.enforce_booking_addon_companion() from public, anon, authenticated;

drop trigger if exists booking_items_addon_companion_guard on public.booking_items;
create constraint trigger booking_items_addon_companion_guard
after insert or update or delete on public.booking_items
deferrable initially deferred
for each row execute function public.enforce_booking_addon_companion();

create or replace function public.apply_booking_service_batch(p_operations jsonb, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_op jsonb; v_kind text; v_service_id uuid; v_title text; v_type_input text; v_type text;
  v_duration integer; v_price integer; v_active boolean; v_requires_companion boolean;
  v_expected timestamptz; v_current_updated_at timestamptz;
  v_created integer := 0; v_updated integer := 0; v_deleted integer := 0;
begin
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) < 1 or jsonb_array_length(p_operations) > 100 then raise exception 'INVALID_BATCH_OPERATIONS'; end if;
  for v_op in select value from jsonb_array_elements(p_operations) loop
    v_kind := lower(btrim(coalesce(v_op->>'op', '')));
    if v_kind not in ('create','update','delete') then raise exception 'INVALID_BATCH_OPERATION'; end if;
    if v_kind = 'delete' then
      begin v_service_id := (v_op->>'serviceId')::uuid; exception when others then raise exception 'INVALID_SERVICE_ID'; end;
      if v_service_id = '00000000-0000-4000-8000-000000000010'::uuid then raise exception 'BOOKING_SYSTEM_SERVICE_IMMUTABLE'; end if;
      select updated_at into v_current_updated_at from public.booking_services where id = v_service_id and deleted_at is null for update;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
      if nullif(v_op->>'expectedUpdatedAt','') is not null then
        begin v_expected := (v_op->>'expectedUpdatedAt')::timestamptz; exception when others then raise exception 'INVALID_EXPECTED_UPDATED_AT'; end;
        if v_current_updated_at <> v_expected then raise exception 'BOOKING_SERVICE_CONFLICT'; end if;
      end if;
      update public.booking_services set is_active = false, deleted_at = now(), deleted_by = nullif(btrim(coalesce(p_actor,'')), '') where id = v_service_id;
      v_deleted := v_deleted + 1; continue;
    end if;

    v_title := btrim(coalesce(v_op->>'title',''));
    v_type_input := btrim(coalesce(v_op->>'serviceType',''));
    begin v_duration := (v_op->>'durationMinutes')::integer; exception when others then raise exception 'INVALID_SERVICE_DURATION'; end;
    begin v_price := (v_op->>'priceAmount')::integer; exception when others then raise exception 'INVALID_SERVICE_PRICE'; end;
    begin v_active := coalesce((v_op->>'isActive')::boolean, true); exception when others then raise exception 'INVALID_BATCH_OPERATION'; end;
    begin v_requires_companion := coalesce((v_op->>'requiresCompanionService')::boolean, false); exception when others then raise exception 'INVALID_BATCH_OPERATION'; end;
    if char_length(v_title) not between 1 and 100 then raise exception 'INVALID_SERVICE_TITLE'; end if;
    if v_duration < 1 or v_duration > 720 then raise exception 'INVALID_SERVICE_DURATION'; end if;
    if v_price < 0 or v_price > 10000000 then raise exception 'INVALID_SERVICE_PRICE'; end if;
    select name into v_type from public.booking_service_types where lower(btrim(name)) = lower(v_type_input) limit 1;
    if not found then raise exception 'BOOKING_SERVICE_TYPE_INVALID'; end if;

    if v_kind = 'create' then
      insert into public.booking_services(
        title, description, service_type, duration_minutes, price_amount,
        counts_toward_membership, is_active, requires_companion_service, created_by
      )
      values (v_title, '__TYPE__:' || v_type, v_type, v_duration, v_price, true, v_active, v_requires_companion, p_actor);
      v_created := v_created + 1;
    else
      begin v_service_id := (v_op->>'serviceId')::uuid; exception when others then raise exception 'INVALID_SERVICE_ID'; end;
      if v_service_id = '00000000-0000-4000-8000-000000000010'::uuid then raise exception 'BOOKING_SYSTEM_SERVICE_IMMUTABLE'; end if;
      select updated_at into v_current_updated_at from public.booking_services where id = v_service_id and deleted_at is null for update;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
      if nullif(v_op->>'expectedUpdatedAt','') is not null then
        begin v_expected := (v_op->>'expectedUpdatedAt')::timestamptz; exception when others then raise exception 'INVALID_EXPECTED_UPDATED_AT'; end;
        if v_current_updated_at <> v_expected then raise exception 'BOOKING_SERVICE_CONFLICT'; end if;
      end if;
      update public.booking_services
      set title=v_title,
          description='__TYPE__:'||v_type,
          service_type=v_type,
          duration_minutes=v_duration,
          price_amount=v_price,
          is_active=v_active,
          requires_companion_service=v_requires_companion
      where id=v_service_id;
      v_updated := v_updated + 1;
    end if;
  end loop;
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'deleted', v_deleted);
end;
$function$;
