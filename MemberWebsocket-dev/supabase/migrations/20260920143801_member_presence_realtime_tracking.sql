create table if not exists public.member_presence_sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  session_id text not null,
  surface text not null check (surface = any (array['member'::text,'points'::text,'event'::text,'calendar'::text,'booking'::text])),
  online_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  offline_at timestamptz null,
  offline_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_presence_sessions_session_id_check
    check (char_length(session_id) between 16 and 80),
  constraint member_presence_sessions_offline_reason_check
    check (offline_reason is null or char_length(offline_reason) <= 30),
  unique (member_id, session_id)
);

create index if not exists member_presence_sessions_member_last_seen_idx
  on public.member_presence_sessions (member_id, last_seen_at desc);

create index if not exists member_presence_sessions_active_idx
  on public.member_presence_sessions (member_id, last_seen_at desc)
  where offline_at is null;

alter table public.member_presence_sessions enable row level security;

revoke all on table public.member_presence_sessions from anon, authenticated;
grant select, insert, update, delete on table public.member_presence_sessions to service_role;

comment on table public.member_presence_sessions is
  'Server-authenticated current member presence sessions. Historical online/offline events remain in audit_logs.';
comment on column public.member_presence_sessions.last_seen_at is
  'Heartbeat timestamp used to determine whether a member is currently online.';
