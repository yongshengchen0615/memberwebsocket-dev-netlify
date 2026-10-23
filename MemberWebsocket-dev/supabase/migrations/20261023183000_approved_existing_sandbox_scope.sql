-- #82: Owner-approved sandbox is this existing Supabase project, not a new project.
-- This is environment authorization only, NEVER permission to discard unbacked data.
-- Project ref is recorded as a non-secret allowlist; application roles have no access.
begin;
create table if not exists maintenance.sandbox_reset_target (
  singleton boolean primary key default true check (singleton = true),
  project_ref text not null check (project_ref = 'dbuquirnaskrwcamdxki'),
  sandbox_approved boolean not null check (sandbox_approved = true),
  approval_reference text not null check (length(approval_reference) >= 5),
  approved_at timestamptz not null default pg_catalog.clock_timestamp(),
  backup_verified_at timestamptz,
  storage_restore_verified_at timestamptz,
  provider_isolation_verified_at timestamptz,
  constraint no_unverified_backup_proof check (
    (backup_verified_at is null) = (storage_restore_verified_at is null)
  )
);
revoke all on table maintenance.sandbox_reset_target from public, anon, authenticated, service_role;
insert into maintenance.sandbox_reset_target(singleton, project_ref, sandbox_approved, approval_reference)
values(true, 'dbuquirnaskrwcamdxki', true, 'user-confirmed-test-project-2026-10-23')
on conflict(singleton) do nothing;

create or replace function maintenance.sandbox_reset_status()
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $function$
declare v_row maintenance.sandbox_reset_target%rowtype; v_readiness jsonb;
begin
  select * into v_row from maintenance.sandbox_reset_target where singleton = true;
  if not found or v_row.project_ref is distinct from 'dbuquirnaskrwcamdxki'
    or v_row.sandbox_approved is distinct from true then
    raise exception 'SANDBOX_SCOPE_NOT_APPROVED';
  end if;
  v_readiness := maintenance.full_reset_readiness();
  return pg_catalog.jsonb_build_object(
    'projectRef', v_row.project_ref,
    'existingProjectApprovedAsSandbox', true,
    'separateProjectRequired', false,
    'databaseBackupVerified', v_row.backup_verified_at is not null,
    'storageRestoreVerified', v_row.storage_restore_verified_at is not null,
    'providerIsolationVerified', v_row.provider_isolation_verified_at is not null,
    'canPermanentlyErase', false,
    'environmentEvidence', v_row.approval_reference,
    'readiness', v_readiness
  );
end;
$function$;
revoke all on function maintenance.sandbox_reset_status()
from public,anon,authenticated,service_role;
commit;
