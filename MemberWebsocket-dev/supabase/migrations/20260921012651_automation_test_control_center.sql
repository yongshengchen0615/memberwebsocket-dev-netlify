create table if not exists public.automation_test_runs (
  id uuid primary key default gen_random_uuid(),
  run_code text not null unique,
  suite text not null check (suite in ('quick','full')),
  environment text not null default 'MemberWebsocket-dev',
  status text not null default 'queued' check (status in ('queued','running','passed','failed','cancelled')),
  triggered_by text not null,
  total_cases integer not null default 0 check (total_cases >= 0),
  passed_cases integer not null default 0 check (passed_cases >= 0),
  failed_cases integer not null default 0 check (failed_cases >= 0),
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (passed_cases + failed_cases <= total_cases)
);

create table if not exists public.automation_test_cases (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.automation_test_runs(id) on delete cascade,
  case_order integer not null check (case_order >= 1),
  case_key text not null,
  name text not null,
  domain text not null,
  member_id uuid references public.members(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','passed','failed','skipped')),
  failure_code text,
  failure_message text,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, case_key),
  unique (run_id, case_order)
);

create table if not exists public.automation_test_steps (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.automation_test_cases(id) on delete cascade,
  step_order integer not null check (step_order >= 1),
  step_key text not null,
  name text not null,
  status text not null default 'queued' check (status in ('queued','running','passed','failed','skipped')),
  expected jsonb not null default '{}'::jsonb,
  actual jsonb not null default '{}'::jsonb,
  message text not null default '',
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, step_order),
  check (jsonb_typeof(expected) in ('object','array','string','number','boolean','null')),
  check (jsonb_typeof(actual) in ('object','array','string','number','boolean','null'))
);

create index if not exists automation_test_runs_created_at_idx
  on public.automation_test_runs (created_at desc);
create index if not exists automation_test_cases_run_order_idx
  on public.automation_test_cases (run_id, case_order);
create index if not exists automation_test_steps_case_order_idx
  on public.automation_test_steps (case_id, step_order);

alter table public.automation_test_runs enable row level security;
alter table public.automation_test_cases enable row level security;
alter table public.automation_test_steps enable row level security;

revoke all on table public.automation_test_runs from public, anon, authenticated;
revoke all on table public.automation_test_cases from public, anon, authenticated;
revoke all on table public.automation_test_steps from public, anon, authenticated;

grant select, insert, update, delete on table public.automation_test_runs to service_role;
grant select, insert, update, delete on table public.automation_test_cases to service_role;
grant select, insert, update, delete on table public.automation_test_steps to service_role;

comment on table public.automation_test_runs is 'Server-authenticated automated QA test runs. Never stores secrets or full tokens.';
comment on table public.automation_test_cases is 'Domain-level cases belonging to an automated QA test run.';
comment on table public.automation_test_steps is 'Observable steps and expected/actual safe snapshots for automated QA cases.';
