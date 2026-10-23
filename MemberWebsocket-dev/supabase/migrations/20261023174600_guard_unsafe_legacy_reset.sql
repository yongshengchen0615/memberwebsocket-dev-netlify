-- #82 SQL Editor one-click reset hardening. No destructive action here.
-- Legacy remove_all_data previously omitted merchant runtime schemas, general
-- admins, managed Auth/Storage and two RESTRICT tenant child tables. Fail closed
-- rather than incorrectly reporting a "clean" database or partially clearing.
begin;
create or replace function maintenance.full_reset_readiness()
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $function$
declare
  v_preview jsonb;
  v_auth integer;
  v_storage integer;
  v_admins integer;
  v_members integer;
  v_roots integer;
  v_tenants integer;
  v_merchants integer;
  v_active_jobs integer := 0;
  v_cron_has_jobs boolean := false;
begin
  v_preview := maintenance.preview_full_reset();
  select count(*)::integer into v_auth from auth.users;
  select count(*)::integer into v_storage from storage.objects;
  select count(*)::integer into v_admins from public.admins;
  select count(*)::integer into v_members from public.members;
  select count(*)::integer into v_roots from platform_private.super_admins;
  select count(*)::integer into v_tenants from platform_private.tenants;
  select count(*)::integer into v_merchants from pg_catalog.pg_namespace
  where nspname ~ '^business_[a-f0-9]{32}$';
  v_cron_has_jobs := pg_catalog.to_regclass('cron.job') is not null;
  if v_cron_has_jobs then
    -- Avoid introducing an unconditional dependency on optional pg_cron.
    execute 'select count(*)::integer from cron.job where active=true'
      into v_active_jobs;
  end if;
  return pg_catalog.jsonb_build_object(
    'version', 1,
    'operation', 'full_environment_reset',
    'databaseOnly', false,
    'canExecute', false,
    'state', 'blocked',
    'counts', pg_catalog.jsonb_build_object(
      'publicAdmins', v_admins, 'publicMembers', v_members,
      'platformRootGrants', v_roots, 'platformTenants', v_tenants,
      'merchantSchemas', v_merchants, 'managedAuthUsers', v_auth,
      'storageObjects', v_storage, 'activeScheduledJobs', v_active_jobs,
      'tablesDiscovered', v_preview->'tableCount',
      'tablesWithRows', v_preview->'nonEmptyTableCount'
    ),
    'requiredBeforeFullReset', pg_catalog.jsonb_build_array(
      'approved_retention_matrix_for_audit_consent_ledger_backups',
      'verified_full_db_and_storage_backup_and_restore',
      'external_line_sessions_webhooks_and_outbox_dispatch_suspended',
      'managed_auth_users_and_storage_objects_processed_by_supported_apis',
      'separately_authenticated_and_authorized_reviewer',
      'tested_last_root_bootstrap_and_member_reregistration',
      'dedicated_sandbox_end_to_end_reset_restore_evidence'
    ),
    'preview', v_preview
  );
end;
$function$;
revoke all on function maintenance.full_reset_readiness()
  from public, anon, authenticated, service_role;

-- Preserve original signature and explicit confirmation contract so existing
-- DBA scripts do not silently perform a misleading incomplete purge.
create or replace function maintenance.remove_all_data(p_confirmation text default null)
returns table(truncated_table_count integer, removed_platform_rows bigint)
language plpgsql security invoker set search_path=''
as $function$
begin
  if p_confirmation is distinct from 'REMOVE ALL DATA' then
    raise exception 'CONFIRM_REMOVE_ALL_DATA_REQUIRED';
  end if;
  raise exception 'FULL_RESET_NOT_READY: run maintenance.full_reset_readiness() and complete Auth/Storage/LINE/backup gates before a supported reset'
    using errcode = '0A000';
end;
$function$;
revoke all on function maintenance.remove_all_data(text)
  from public, anon, authenticated, service_role;
commit;
