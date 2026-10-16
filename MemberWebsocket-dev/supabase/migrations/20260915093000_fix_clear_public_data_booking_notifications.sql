-- Keep the one-click public data reset compatible with the private booking notification outbox.
-- The outbox has a foreign key to public.bookings, so PostgreSQL requires both tables in the
-- same TRUNCATE statement. Do not use CASCADE here: the reset scope should stay explicit.
-- booking_notifications.config and Vault secrets are intentionally preserved.

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

  -- booking_notifications.outbox references public.bookings. Include only this private
  -- application-data table in the same TRUNCATE; keep notification configuration/secrets.
  if to_regclass('booking_notifications.outbox') is not null then
    table_list := table_list || ', ' || format('%I.%I', 'booking_notifications', 'outbox');
    table_count := table_count + 1;
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
