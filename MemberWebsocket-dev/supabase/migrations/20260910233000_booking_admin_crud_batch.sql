-- Booking admin CRUD/batch support.
-- Services use soft deletion so historical booking foreign keys remain valid.

alter table public.booking_services
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text;

create index if not exists booking_services_not_deleted_idx
  on public.booking_services (created_at)
  where deleted_at is null;

comment on column public.booking_services.deleted_at is
  'Soft-delete timestamp. Deleted services remain for historical booking references but are excluded from admin/member selection.';
comment on column public.booking_services.deleted_by is
  'LINE user id of the administrator that soft-deleted the service.';

-- Recreate the internal 10-minute store service if an environment reset removed it.
insert into public.booking_services(
  id, title, description, service_type,
  work_start_time, work_end_time, slot_minutes, min_advance_days,
  available_weekdays, duration_minutes, price_amount,
  counts_toward_membership, is_active, created_by, deleted_at, deleted_by
) values (
  '00000000-0000-4000-8000-000000000010'::uuid,
  '店內服務（肩頸／龜苓膏／熱茶）',
  '__SYSTEM__:included-store-service',
  '店內招待',
  '09:00:00', '17:00:00', 30, 0,
  array[0,1,2,3,4,5,6]::smallint[], 10, 0,
  false, true, 'system', null, null
)
on conflict (id) do update set
  title = excluded.title,
  description = excluded.description,
  service_type = excluded.service_type,
  duration_minutes = 10,
  price_amount = 0,
  counts_toward_membership = false,
  is_active = true,
  deleted_at = null,
  deleted_by = null;

create or replace function public.rename_booking_service_type(
  p_type_id uuid,
  p_name text,
  p_actor text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_name text;
  v_new_name text := btrim(coalesce(p_name, ''));
begin
  if char_length(v_new_name) not between 1 and 80 then
    raise exception 'INVALID_SERVICE_TYPE_NAME';
  end if;

  select name into v_old_name
  from public.booking_service_types
  where id = p_type_id
  for update;

  if not found then raise exception 'BOOKING_SERVICE_TYPE_NOT_FOUND'; end if;

  if exists (
    select 1 from public.booking_service_types
    where id <> p_type_id and lower(btrim(name)) = lower(v_new_name)
  ) then
    raise exception 'DUPLICATE_SERVICE_TYPE';
  end if;

  update public.booking_service_types
  set name = v_new_name, updated_at = now()
  where id = p_type_id;

  update public.booking_services
  set service_type = v_new_name,
      description = '__TYPE__:' || v_new_name
  where coalesce(counts_toward_membership, true) = true
    and lower(btrim(coalesce(service_type, ''))) = lower(btrim(v_old_name));
end;
$$;

revoke all on function public.rename_booking_service_type(uuid, text, text) from public, anon, authenticated;
grant execute on function public.rename_booking_service_type(uuid, text, text) to service_role;

create or replace function public.delete_booking_service_type(
  p_type_id uuid,
  p_actor text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  select name into v_name
  from public.booking_service_types
  where id = p_type_id
  for update;

  if not found then raise exception 'BOOKING_SERVICE_TYPE_NOT_FOUND'; end if;

  if exists (
    select 1
    from public.booking_services
    where deleted_at is null
      and coalesce(counts_toward_membership, true) = true
      and lower(btrim(coalesce(service_type, ''))) = lower(btrim(v_name))
  ) then
    raise exception 'BOOKING_SERVICE_TYPE_IN_USE';
  end if;

  delete from public.booking_service_types where id = p_type_id;
end;
$$;

revoke all on function public.delete_booking_service_type(uuid, text) from public, anon, authenticated;
grant execute on function public.delete_booking_service_type(uuid, text) to service_role;

create or replace function public.apply_booking_service_batch(
  p_operations jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_op jsonb;
  v_kind text;
  v_service_id uuid;
  v_title text;
  v_type_input text;
  v_type text;
  v_duration integer;
  v_price integer;
  v_active boolean;
  v_expected timestamptz;
  v_current_updated_at timestamptz;
  v_created integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
begin
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) < 1 or jsonb_array_length(p_operations) > 100 then
    raise exception 'INVALID_BATCH_OPERATIONS';
  end if;

  for v_op in select value from jsonb_array_elements(p_operations)
  loop
    v_kind := lower(btrim(coalesce(v_op->>'op', '')));
    if v_kind not in ('create','update','delete') then raise exception 'INVALID_BATCH_OPERATION'; end if;

    if v_kind = 'delete' then
      begin v_service_id := (v_op->>'serviceId')::uuid;
      exception when others then raise exception 'INVALID_SERVICE_ID'; end;
      if v_service_id = '00000000-0000-4000-8000-000000000010'::uuid then raise exception 'BOOKING_SYSTEM_SERVICE_IMMUTABLE'; end if;

      select updated_at into v_current_updated_at from public.booking_services
      where id = v_service_id and deleted_at is null for update;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;

      if nullif(v_op->>'expectedUpdatedAt','') is not null then
        begin v_expected := (v_op->>'expectedUpdatedAt')::timestamptz;
        exception when others then raise exception 'INVALID_EXPECTED_UPDATED_AT'; end;
        if v_current_updated_at <> v_expected then raise exception 'BOOKING_SERVICE_CONFLICT'; end if;
      end if;

      update public.booking_services
      set is_active = false, deleted_at = now(), deleted_by = nullif(btrim(coalesce(p_actor,'')), '')
      where id = v_service_id;
      v_deleted := v_deleted + 1;
      continue;
    end if;

    v_title := btrim(coalesce(v_op->>'title',''));
    v_type_input := btrim(coalesce(v_op->>'serviceType',''));
    begin v_duration := (v_op->>'durationMinutes')::integer;
    exception when others then raise exception 'INVALID_SERVICE_DURATION'; end;
    begin v_price := (v_op->>'priceAmount')::integer;
    exception when others then raise exception 'INVALID_SERVICE_PRICE'; end;
    v_active := coalesce((v_op->>'isActive')::boolean, true);

    if char_length(v_title) not between 1 and 100 then raise exception 'INVALID_SERVICE_TITLE'; end if;
    if v_duration < 1 or v_duration > 720 then raise exception 'INVALID_SERVICE_DURATION'; end if;
    if v_price < 0 or v_price > 10000000 then raise exception 'INVALID_SERVICE_PRICE'; end if;

    select name into v_type
    from public.booking_service_types
    where lower(btrim(name)) = lower(v_type_input)
    limit 1;
    if not found then raise exception 'BOOKING_SERVICE_TYPE_INVALID'; end if;

    if v_kind = 'create' then
      insert into public.booking_services(
        title, description, service_type, duration_minutes, price_amount,
        counts_toward_membership, is_active, created_by
      ) values (
        v_title, '__TYPE__:' || v_type, v_type, v_duration, v_price,
        true, v_active, p_actor
      );
      v_created := v_created + 1;
    else
      begin v_service_id := (v_op->>'serviceId')::uuid;
      exception when others then raise exception 'INVALID_SERVICE_ID'; end;
      if v_service_id = '00000000-0000-4000-8000-000000000010'::uuid then raise exception 'BOOKING_SYSTEM_SERVICE_IMMUTABLE'; end if;

      select updated_at into v_current_updated_at from public.booking_services
      where id = v_service_id and deleted_at is null for update;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;

      if nullif(v_op->>'expectedUpdatedAt','') is not null then
        begin v_expected := (v_op->>'expectedUpdatedAt')::timestamptz;
        exception when others then raise exception 'INVALID_EXPECTED_UPDATED_AT'; end;
        if v_current_updated_at <> v_expected then raise exception 'BOOKING_SERVICE_CONFLICT'; end if;
      end if;

      update public.booking_services
      set title = v_title,
          description = '__TYPE__:' || v_type,
          service_type = v_type,
          duration_minutes = v_duration,
          price_amount = v_price,
          is_active = v_active
      where id = v_service_id;
      v_updated := v_updated + 1;
    end if;
  end loop;

  return jsonb_build_object('created', v_created, 'updated', v_updated, 'deleted', v_deleted);
end;
$$;

revoke all on function public.apply_booking_service_batch(jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_booking_service_batch(jsonb, text) to service_role;

-- Keep environment reset safe: restore singleton settings and the internal service.
create or replace function maintenance.clear_public_data(confirm_clear boolean default false)
returns table(truncated_table_count integer)
language plpgsql
set search_path = ''
as $$
declare
  table_list text;
  table_count integer;
begin
  if confirm_clear is distinct from true then
    raise exception 'Refusing to clear data: call maintenance.clear_public_data(true) to confirm';
  end if;

  select
    string_agg(format('%I.%I', schemaname, tablename), ', ' order by tablename),
    count(*)::integer
  into table_list, table_count
  from pg_catalog.pg_tables
  where schemaname = 'public';

  if table_list is null then
    return query select 0;
    return;
  end if;

  execute 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY';

  insert into public.booking_settings(id, work_start_time, work_end_time, updated_by)
  values (1, '09:00:00', '17:00:00', 'system')
  on conflict (id) do nothing;

  insert into public.membership_tier_settings(tier_key, tier_label, required_service_minutes, style_key, updated_by)
  values
    ('general', '一般會員', 0, 'forest', 'system'),
    ('silver', '銀級會員', 600, 'ocean', 'system'),
    ('gold', '金級會員', 1800, 'gold', 'system'),
    ('platinum', '白金會員', 3600, 'platinum', 'system')
  on conflict (tier_key) do nothing;

  insert into public.booking_services(
    id, title, description, service_type,
    work_start_time, work_end_time, slot_minutes, min_advance_days,
    available_weekdays, duration_minutes, price_amount,
    counts_toward_membership, is_active, created_by
  ) values (
    '00000000-0000-4000-8000-000000000010'::uuid,
    '店內服務（肩頸／龜苓膏／熱茶）',
    '__SYSTEM__:included-store-service',
    '店內招待',
    '09:00:00', '17:00:00', 30, 0,
    array[0,1,2,3,4,5,6]::smallint[], 10, 0,
    false, true, 'system'
  ) on conflict (id) do nothing;

  return query select table_count;
end;
$$;
