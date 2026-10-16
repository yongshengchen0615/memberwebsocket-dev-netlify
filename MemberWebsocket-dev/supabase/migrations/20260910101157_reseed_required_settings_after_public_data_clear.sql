-- Keep maintenance.clear_public_data useful for environment resets without
-- leaving singleton system configuration tables unusable.
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

  insert into public.booking_settings
    (id, work_start_time, work_end_time, updated_by)
  values
    (1, '09:00:00', '17:00:00', 'system')
  on conflict (id) do nothing;

  insert into public.membership_tier_settings
    (tier_key, tier_label, required_service_minutes, style_key, updated_by)
  values
    ('general', '一般會員', 0, 'forest', 'system'),
    ('silver', '銀級會員', 600, 'ocean', 'system'),
    ('gold', '金級會員', 1800, 'gold', 'system'),
    ('platinum', '白金會員', 3600, 'platinum', 'system')
  on conflict (tier_key) do nothing;

  return query select table_count;
end;
$$;
