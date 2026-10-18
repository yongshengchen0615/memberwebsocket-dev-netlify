-- P1 sandbox REFERENCE ONLY. This file is NOT in supabase/migrations.
-- Apply ONLY to a NEW, EMPTY, ISOLATED Platform Control test project after review.
-- NOT for legacy production dbuquirnaskrwcamdxki.
-- NEVER seed or grant any super-admin here; no service_role keys are stored.
-- Before operational deployment use "supabase migration new" to create a
-- versioned migration and validate with fresh/upgrade/rollback test databases.
--
-- Preconditions: Postgres 15+, platform_private is absent, no existing data.
-- Uses native gen_random_uuid(), jsonb, timestamptz.

begin;

create schema platform_private;
revoke all on schema platform_private from public, anon, authenticated;
grant usage on schema platform_private to service_role;
alter default privileges in schema platform_private revoke execute on functions from public;

-- A Platform Root must be explicitly inserted/approved by an authenticated
-- privileged database operator after external LINE identity checks. NO SEED.
create table platform_private.platform_operators (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null unique
    check (line_user_id ~ '^U[0-9a-f]{32}$'),
  role text not null check (role = 'super_admin'),
  enabled boolean not null default false,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operator_enabled_requires_review
    check (not enabled or
      (nullif(btrim(approved_by), '') is not null and approved_at is not null))
);
create unique index single_platform_root
  on platform_private.platform_operators(role) where role = 'super_admin';

-- Eight exact booleans; align with the existing platform_features_valid contract.
create function platform_private.features_valid(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p) = 'object'
    and p ?& array['membership','points','events','calendar','integrations','booking','testing','usage']
    and (select count(*) from jsonb_object_keys(p)) = 8
    and not exists (select 1 from jsonb_each(p) where jsonb_typeof(value) <> 'boolean'), false)
$$;
revoke all on function platform_private.features_valid(jsonb) from public, anon, authenticated;
grant execute on function platform_private.features_valid(jsonb) to service_role;

create table platform_private.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  slug text not null unique
    check (char_length(slug) between 3 and 40
      and slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
      and slug not in ('admin','platform','api','www','root','system')),
  owner_line_user_id text not null
    check (owner_line_user_id ~ '^U[0-9a-f]{32}$'),
  features jsonb not null check (platform_private.features_valid(features)),
  line_config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(line_config) = 'object'),
  credentials_configured boolean not null default false,
  status text not null default 'pending_provisioning'
    check (status in ('pending_provisioning','active','suspended')),
  isolation_verified_at timestamptz,
  isolation_version text,
  version integer not null default 1 check (version > 0),
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_isolation_metadata_gate
    check (status <> 'active' or
      (isolation_verified_at is not null
       and nullif(isolation_version,'') is not null
       and credentials_configured))
);
create index tenants_updated_idx on platform_private.tenants(updated_at desc, id);

create table platform_private.applications (
  id uuid primary key default gen_random_uuid(),
  applicant_line_user_id text not null unique
    check (applicant_line_user_id ~ '^U[0-9a-f]{32}$'),
  business_name text not null
    check (char_length(btrim(business_name)) between 1 and 100),
  slug text not null unique
    check (char_length(slug) between 3 and 40
      and slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
      and slug not in ('admin','platform','api','www','root','system')),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  tenant_id uuid unique references platform_private.tenants(id) on delete restrict,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approved_requires_tenant check
    ((status='approved') = (tenant_id is not null)),
  constraint review_requires_actor check
    (status='pending' or
      (nullif(btrim(reviewed_by),'') is not null and reviewed_at is not null))
);

-- Registry may temporarily have NULL project_ref until Management API succeeds.
-- Each tenant can reference only one current project, and refs cannot repeat.
create table platform_private.tenant_environments (
  tenant_id uuid primary key references platform_private.tenants(id) on delete restrict,
  project_ref text unique
    check (project_ref is null or project_ref ~ '^[a-z]{20}$'),
  region text not null,
  stage text not null default 'pending'
    check (stage in
      ('pending','creating','project_created','deploying','verified','quarantined','retired')),
  schema_version text,
  deployment_sha text,
  verified_at timestamptz,
  health_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint verified_environment_must_have_evidence
    check (stage <> 'verified' or
      (project_ref is not null
       and nullif(schema_version,'') is not null
       and verified_at is not null and health_checked_at is not null))
);

-- A tamper-resistant metadata gate complements authorization by the server.
-- This CANNOT replace actual cross-project security and E2E isolation tests.
create function platform_private.check_tenant_activation()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare ready boolean;
begin
  if new.status <> 'active' then
    return new;
  end if;
  select e.stage = 'verified'
     and e.verified_at is not null
     and e.health_checked_at is not null
     and e.project_ref is not null
     and e.schema_version = new.isolation_version
  into ready
  from platform_private.tenant_environments e
  where e.tenant_id = new.id;
  if not coalesce(ready,false)
    or new.isolation_verified_at is null
    or not new.credentials_configured then
    raise exception 'TENANT_NOT_PROVISIONED';
  end if;
  return new;
end $$;
revoke all on function platform_private.check_tenant_activation()
  from public, anon, authenticated;
create trigger tenant_activation_guard
before insert or update of status,isolation_verified_at,isolation_version,credentials_configured
on platform_private.tenants
for each row execute function platform_private.check_tenant_activation();

-- To quarantine or retire an environment that currently serves an active
-- tenant, suspend the tenant FIRST in the SAME database transaction.
-- This prevents a healthy=false environment with an active tenant record.
create function platform_private.prevent_active_environment_downgrade()
returns trigger language plpgsql security invoker set search_path = '' as $
declare active_tenant boolean;
begin
  select t.status='active' into active_tenant
  from platform_private.tenants t
  where t.id = new.tenant_id
  for update;
  if coalesce(active_tenant,false) and
      (new.stage <> 'verified'
       or new.verified_at is null
       or new.health_checked_at is null
       or new.project_ref is null
       or new.schema_version is null) then
    raise exception 'SUSPEND_ACTIVE_TENANT_FIRST';
  end if;
  return new;
end $;
revoke all on function platform_private.prevent_active_environment_downgrade()
  from public, anon, authenticated;
create trigger active_environment_downgrade_guard
before update of stage,verified_at,health_checked_at,project_ref,schema_version
on platform_private.tenant_environments
for each row execute function platform_private.prevent_active_environment_downgrade();

-- Unique request identity is enforced at DB level; application worker must also
-- serialise retries with a transaction, lease and reconciliation before creating
-- any billable Supabase project.
create table platform_private.provisioning_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform_private.tenants(id) on delete restrict,
  idempotency_key uuid not null unique,
  operation text not null
    check (operation in ('create_project','upgrade_project','verify_environment')),
  state text not null default 'queued'
    check (state in ('queued','running','verified','failed','manual_review')),
  attempts integer not null default 0 check (attempts >= 0),
  lease_until timestamptz,
  error_code text, -- machine-readable code ONLY, not request body / token
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index provisioning_jobs_queue_idx
 on platform_private.provisioning_jobs(state,lease_until,created_at);

-- Ciphertext stays bound to the tenant id by AES-GCM AAD; never store plaintext
-- or platform Supabase Management API scoped PAT in a tenant row or browser.
create table platform_private.tenant_secrets (
  tenant_id uuid primary key references platform_private.tenants(id) on delete restrict,
  envelope jsonb not null
    check (coalesce(jsonb_typeof(envelope)='object'
      and envelope->>'version'='1'
      and char_length(envelope->>'iv')=16
      and char_length(envelope->>'data')>40,false)),
  key_version integer not null default 1 check (key_version>=1),
  updated_at timestamptz not null default now()
);

-- Each phase of legacy migration records evidence without personal data.
create table platform_private.migration_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform_private.tenants(id) on delete restrict,
  dataset text not null,
  run_key uuid not null,
  source_project_ref text not null,
  target_project_ref text not null,
  cursor_token text, -- opaque checkpoint, must not contain member PII
  record_count bigint check (record_count is null or record_count>=0),
  checksum_sha256 text
    check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending'
    check (state in ('pending','copying','verified','failed','reverted')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(tenant_id,dataset,run_key)
);

create table platform_private.requests (
  request_id uuid primary key,
  actor text not null,
  operation text not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now()
);

create table platform_private.audit_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid,
  actor text not null,
  tenant_id uuid references platform_private.tenants(id) on delete restrict,
  action text not null,
  result text not null
    check (result in ('success','rejected','failed')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_tenant_time_idx
 on platform_private.audit_events(tenant_id,created_at desc);

-- Only privileged backend service_role should read or write private tables.
-- SECURITY INVOKER, not SECURITY DEFINER, by default.
alter table platform_private.platform_operators enable row level security;
alter table platform_private.applications enable row level security;
alter table platform_private.tenants enable row level security;
alter table platform_private.tenant_environments enable row level security;
alter table platform_private.provisioning_jobs enable row level security;
alter table platform_private.tenant_secrets enable row level security;
alter table platform_private.migration_runs enable row level security;
alter table platform_private.requests enable row level security;
alter table platform_private.audit_events enable row level security;

revoke all on all tables in schema platform_private from public, anon, authenticated;
-- Even service_role must NOT have DML on root authority.
-- Only a separately authorized DB operator can manually grant root.
revoke all on platform_private.platform_operators from service_role;
grant select on platform_private.platform_operators to service_role;
grant select,insert,update on
  platform_private.applications,
  platform_private.tenants,
  platform_private.tenant_environments,
  platform_private.provisioning_jobs,
  platform_private.tenant_secrets,
  platform_private.migration_runs,
  platform_private.requests
to service_role;
grant select,insert on platform_private.audit_events to service_role;

-- No INSERT into platform_operators; root remains 0 until human DB approval.
-- No initial tenant/project rows. No activation and no data deletion.
commit;
