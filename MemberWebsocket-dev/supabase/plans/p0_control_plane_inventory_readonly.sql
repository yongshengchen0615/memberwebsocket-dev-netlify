-- P0 inventory: READ ONLY. Intended for SQL Editor against the EXISTING legacy DB.
-- NO DDL/DML, no tenant activation, no privilege grant, no secret values.
-- Record execution timestamp and project_ref separately as test evidence.
-- Edge Function counts/settings, backups and external LINE configuration require
-- Management API and provider inventory; SQL cannot prove those are complete.

select
  current_timestamp as observed_at_utc,
  current_database() as db_name,
  (select count(*) from information_schema.tables
   where table_schema='public' and table_type='BASE TABLE') as public_tables,
  (select count(*) from pg_tables
   where schemaname='public' and rowsecurity) as public_rls_enabled,
  (select count(*) from pg_policies where schemaname='public') as public_rls_policies,
  (select count(*) from information_schema.columns
   where table_schema='public'
     and column_name in ('tenant_id','merchant_id','organization_id','shop_id')) as tenant_scoped_columns,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prosecdef) as public_security_definer,
  (select count(*) from pg_publication_tables where pubname='supabase_realtime') as realtime_publication_tables,
  (select count(*) from storage.buckets) as storage_buckets,
  (select count(*) from storage.buckets where public) as public_storage_buckets,
  (select count(*) from pg_extension where extname='pg_cron') as pg_cron_installed;

select
  current_timestamp as observed_at_utc,
  has_schema_privilege('anon','platform_private','USAGE') as anon_platform_usage,
  has_schema_privilege('authenticated','platform_private','USAGE') as authenticated_platform_usage,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prosecdef
     and has_function_privilege('anon',p.oid,'EXECUTE')) as anon_executable_public_definer,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prosecdef
     and has_function_privilege('authenticated',p.oid,'EXECUTE')) as authenticated_executable_public_definer;

select
  current_timestamp as observed_at_utc,
  (select count(*) from platform_private.tenants) as registered_tenants,
  (select count(*) from platform_private.tenants where status='active') as active_tenants,
  (select count(*) from platform_private.applications) as applications,
  (select count(*) from platform_private.super_admins) as manually_bound_root_rows,
  (select count(*) from platform_private.super_admins where enabled) as enabled_root_rows;

-- Function surface inventory: NO function bodies / secrets are returned.
select n.nspname as schema_name,
       count(*) filter (where p.prosecdef) as security_definer_count,
       count(*) as all_function_count
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','platform_private','maintenance','booking_notifications')
group by n.nspname order by n.nspname;

-- Summarizes table protections without returning user rows.
select n.nspname as schema_name,
       count(*) as table_count,
       count(*) filter (where c.relrowsecurity) as rls_enabled_count
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind='r'
  and n.nspname in ('public','platform_private','booking_notifications')
group by n.nspname order by n.nspname;

-- NOTE: Storage backup must read/download object bytes separately.
-- Database backups include Storage metadata, NOT Storage object bytes.
-- Do NOT execute maintenance.clear_public_data or remove_all_data.
