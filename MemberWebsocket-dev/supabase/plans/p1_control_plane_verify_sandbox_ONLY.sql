-- P1 SANDBOX-ONLY non-mutating acceptance probes.
-- Run ONLY on a clean isolated Platform Control Project after applying P1 SQL.
-- Expected: all *_ok columns are TRUE.  These probes alone are not sufficient:
-- concurrency, API, browser, remote key management and backup tests still required.

select
  current_timestamp as checked_at_utc,
  (select count(*) = 9 from information_schema.tables
     where table_schema = 'platform_private' and table_type = 'BASE TABLE')
     as nine_private_tables_ok,
  (select count(*) = 9 from pg_tables
     where schemaname = 'platform_private' and rowsecurity)
     as nine_tables_rls_ok,
  (select count(*) = 0 from platform_private.platform_operators)
     as zero_auto_provisioned_roots_ok,
  not has_schema_privilege('anon','platform_private','USAGE')
     as anon_no_schema_access_ok,
  not has_schema_privilege('authenticated','platform_private','USAGE')
     as authenticated_no_schema_access_ok,
  not has_table_privilege('service_role','platform_private.platform_operators','INSERT')
     as api_cannot_grant_root_ok,
  not has_table_privilege('service_role','platform_private.platform_operators','UPDATE')
     as api_cannot_enable_root_ok,
  has_table_privilege('service_role','platform_private.platform_operators','SELECT')
     as api_may_read_root_ok,
  not has_table_privilege('service_role','platform_private.audit_events','UPDATE')
     as audit_append_only_privilege_ok;

select
  platform_private.features_valid('{"membership":false,"points":false,"events":false,"calendar":false,"integrations":false,"booking":false,"testing":false,"usage":false}'::jsonb)
     as eight_flags_accepted_ok,
  not platform_private.features_valid('{"membership":true}'::jsonb)
     as missing_flags_rejected_ok,
  not platform_private.features_valid('{"membership":"true","points":false,"events":false,"calendar":false,"integrations":false,"booking":false,"testing":false,"usage":false}'::jsonb)
     as string_flag_rejected_ok;

select
  (select count(*) = 1 from pg_trigger
     where tgrelid='platform_private.tenants'::regclass
       and tgname='tenant_activation_guard' and not tgisinternal)
     as tenant_activation_trigger_present_ok,
  (select count(*) = 1 from pg_indexes
     where schemaname='platform_private'
       and tablename='platform_operators'
       and indexname='single_platform_root')
     as root_unique_index_present_ok,
  (select count(*) = 0 from pg_policies
     where schemaname='platform_private')
     as private_rls_policy_default_deny_ok,
  (select count(*) = 0 from platform_private.tenant_environments)
     as no_auto_created_merchant_projects_ok;

-- Stronger AC-P1 checks: transaction isolation, duplicate request IDs, RLS
-- negative paths and activation gating must be run against a resettable
-- PostgreSQL sandbox with synthetic applicants A/B, and must inspect DB state.
-- NEVER grant real root here; use synthetic U followed by 32 lowercase hex.
