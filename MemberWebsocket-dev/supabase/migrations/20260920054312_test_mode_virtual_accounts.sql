alter table public.members
  add column if not exists is_test_account boolean not null default false,
  add column if not exists test_account_sequence bigint;

create unique index if not exists members_test_account_sequence_uidx
  on public.members (test_account_sequence)
  where is_test_account = true;

create sequence if not exists public.test_member_sequence
  as bigint
  start with 1
  increment by 1
  minvalue 1
  no maxvalue
  cache 1;

create table if not exists public.test_mode_settings (
  id boolean primary key default true check (id = true),
  enabled boolean not null default false,
  allow_admin_user_login boolean not null default false,
  maintenance_message text not null default '',
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint test_mode_settings_message_length_check
    check (char_length(maintenance_message) <= 500)
);

insert into public.test_mode_settings (id)
values (true)
on conflict (id) do nothing;

create table if not exists public.test_login_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  admin_line_user_id text not null references public.admins(line_user_id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  constraint test_login_sessions_token_hash_check
    check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint test_login_sessions_expiry_check
    check (expires_at > created_at)
);

create index if not exists test_login_sessions_member_idx
  on public.test_login_sessions (member_id);
create index if not exists test_login_sessions_admin_idx
  on public.test_login_sessions (admin_line_user_id);
create index if not exists test_login_sessions_active_expiry_idx
  on public.test_login_sessions (expires_at)
  where revoked_at is null;

alter table public.test_mode_settings enable row level security;
alter table public.test_login_sessions enable row level security;

revoke all on table public.test_mode_settings from public, anon, authenticated;
revoke all on table public.test_login_sessions from public, anon, authenticated;
revoke all on sequence public.test_member_sequence from public, anon, authenticated;

grant select, insert, update, delete on table public.test_mode_settings to service_role;
grant select, insert, update, delete on table public.test_login_sessions to service_role;
grant usage, select on sequence public.test_member_sequence to service_role;
