create or replace function maintenance.clear_public_data(confirm_clear boolean default false)
returns table(truncated_table_count integer)
language plpgsql
set search_path = ''
as $function$
declare
  table_list text;
  table_count integer;
begin
  if confirm_clear is distinct from true then
    raise exception 'Refusing to clear data: call maintenance.clear_public_data(true) to confirm';
  end if;

  select
    string_agg(format('%I.%I', schemaname, tablename), ', ' order by schemaname, tablename),
    count(*)::integer
  into table_list, table_count
  from pg_catalog.pg_tables
  where schemaname in ('public','booking_notifications')
    and not (schemaname = 'public' and tablename = 'admins');

  if table_list is null then
    return query select 0;
    return;
  end if;

  execute 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY';

  insert into public.booking_settings
    (id, work_start_time, work_end_time, min_advance_days, booking_notice, updated_by)
  values
    (1, '09:00:00', '17:00:00', 0, '', 'system')
  on conflict (id) do update set
    work_start_time = excluded.work_start_time,
    work_end_time = excluded.work_end_time,
    min_advance_days = excluded.min_advance_days,
    booking_notice = excluded.booking_notice,
    updated_by = excluded.updated_by,
    updated_at = now();

  insert into public.membership_tier_settings
    (tier_key, tier_label, required_service_minutes, style_key, updated_by)
  values
    ('general', '一般會員', 0, 'forest', 'system'),
    ('silver', '銀級會員', 600, 'ocean', 'system'),
    ('gold', '金級會員', 1800, 'gold', 'system'),
    ('platinum', '白金會員', 3600, 'platinum', 'system')
  on conflict (tier_key) do update set
    tier_label = excluded.tier_label,
    required_service_minutes = excluded.required_service_minutes,
    style_key = excluded.style_key,
    updated_by = excluded.updated_by,
    updated_at = now();

  insert into public.point_card_settings
    (id, max_tickets_per_redemption, updated_by)
  values
    (1, 1, 'system')
  on conflict (id) do update set
    max_tickets_per_redemption = excluded.max_tickets_per_redemption,
    updated_by = excluded.updated_by,
    updated_at = now();

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

  insert into booking_notifications.config(id, enabled)
  values (true, false)
  on conflict (id) do update set enabled = excluded.enabled;

  return query select table_count;
end;
$function$;
