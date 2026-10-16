-- One-click clear keeps administrators only, then rebuilds the deterministic
-- system baseline. All member, consent, legal-content, booking, ticket, QA and
-- operational data is cleared.
--
-- This is intentionally narrower than preserving business data: admins survive,
-- system defaults are recreated by ensure_required_system_baseline(), and
-- everything else is reset.

create or replace function maintenance.clear_non_admin_data(confirm_clear boolean default false)
returns table(truncated_table_count integer)
language plpgsql
set search_path = ''
as $function$
declare
  table_list text;
  table_count integer;
  admin_count_before bigint;
  admin_count_after bigint;
begin
  if confirm_clear is distinct from true then
    raise exception 'Refusing to clear data: call maintenance.clear_non_admin_data(true) to confirm';
  end if;

  select count(*) into admin_count_before from public.admins;

  select
    string_agg(format('%I.%I', schemaname, tablename), ', ' order by schemaname, tablename),
    count(*)::integer
  into table_list, table_count
  from pg_catalog.pg_tables
  where schemaname in ('public', 'booking_notifications')
    and not (schemaname = 'public' and tablename = 'admins');

  if table_list is not null then
    execute 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY';
  end if;

  perform maintenance.ensure_required_system_baseline();

  select count(*) into admin_count_after from public.admins;
  if admin_count_after is distinct from admin_count_before then
    raise exception 'ADMIN_PRESERVATION_FAILED';
  end if;

  return query select coalesce(table_count, 0);
end;
$function$;
