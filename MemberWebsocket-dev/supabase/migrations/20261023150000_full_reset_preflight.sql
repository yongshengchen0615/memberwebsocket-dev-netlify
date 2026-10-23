-- #82: Read-only inventory for a proposed full clean/usable reset.
-- This does NOT authorize, schedule, or perform any deletion.
-- SQL Editor (privileged DBA only): select maintenance.preview_full_reset();
begin;
create or replace function maintenance.preview_full_reset()
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $function$
declare
  item record;
  v_has_rows boolean;
  v_assets jsonb := '[]'::jsonb;
  v_nonempty integer := 0;
  v_total integer := 0;
  v_group text;
  v_policy text;
begin
  -- Query every currently discoverable table. Do not trust a hardcoded table
  -- count: future tenant schemas and migrations must also appear in the report.
  for item in
    select t.schemaname, t.tablename
    from pg_catalog.pg_tables t
    where t.schemaname in ('public', 'booking_notifications', 'platform_private',
                           'auth', 'storage', 'line_config')
       or t.schemaname ~ '^business_[a-f0-9]{32}$'
    order by t.schemaname, t.tablename
  loop
    -- Identifiers originate in pg_catalog and are quoted independently.
    -- Existence only: no member rows, credentials or object paths are returned.
    execute pg_catalog.format('select exists(select 1 from %I.%I)',
                              item.schemaname, item.tablename)
      into v_has_rows;
    v_total := v_total + 1;
    if v_has_rows then v_nonempty := v_nonempty + 1; end if;

    v_group := case
      when item.schemaname = 'auth' then 'managed_auth'
      when item.schemaname = 'storage' then 'managed_storage'
      when item.schemaname = 'platform_private' then 'platform_control_plane'
      when item.schemaname ~ '^business_[a-f0-9]{32}$' then 'business_tenant'
      when item.schemaname = 'public' and item.tablename = 'admins' then 'general_admins'
      when item.schemaname = 'public' and item.tablename = 'members' then 'members'
      when item.schemaname = 'booking_notifications' then 'notifications'
      else 'application_or_baseline'
    end;
    v_policy := case
      when item.schemaname in ('auth', 'storage') then 'managed_api_review_required'
      when item.tablename ~ '(audit|consent|legal|ledger)' then 'retention_review_required'
      else 'disposition_not_approved'
    end;
    v_assets := v_assets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('schema', item.schemaname,
        'table', item.tablename, 'category', v_group,
        'hasRows', v_has_rows, 'disposition', v_policy));
  end loop;

  return pg_catalog.jsonb_build_object(
    'version', 1,
    'operation', 'full_environment_reset',
    'readOnly', true,
    'executionAllowed', false,
    'complete', false,
    'tableCount', v_total,
    'nonEmptyTableCount', v_nonempty,
    'assets', v_assets,
    'blockers', pg_catalog.jsonb_build_array(
      'production_or_independent_sandbox_not_verified',
      'data_retention_and_audit_policy_not_approved',
      'full_auth_and_line_session_revocation_not_verified',
      'storage_objects_and_backups_not_reconciled',
      'tenant_worker_outbox_and_external_provider_not_isolated',
      'last_root_bootstrap_and_restore_not_proven',
      'two_person_authorization_and_backup_restore_not_proven'
    ));
exception when insufficient_privilege then
  -- An incomplete scan must not be mistaken for an empty database.
  raise exception 'FULL_RESET_PREFLIGHT_INCOMPLETE_PRIVILEGE' using errcode='42501';
end;
$function$;
-- Never expose this inventory through the PostgREST service or login roles.
revoke all on function maintenance.preview_full_reset() from public, anon, authenticated, service_role;
commit;
