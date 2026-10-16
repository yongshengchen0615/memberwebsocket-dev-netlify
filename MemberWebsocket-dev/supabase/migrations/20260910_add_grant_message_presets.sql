create table public.grant_message_presets (
  id uuid primary key default gen_random_uuid(),
  preset_id text not null unique,
  title text not null check (char_length(title) between 1 and 80),
  message text not null check (char_length(message) between 1 and 1000),
  status text not null default 'active' check (status in ('active','archived')),
  sort_order integer not null default 0,
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index grant_message_presets_status_sort_idx
  on public.grant_message_presets (status, sort_order, created_at);

alter table public.grant_message_presets enable row level security;

revoke all on table public.grant_message_presets from anon, authenticated;
grant select, insert, update, delete on table public.grant_message_presets to service_role;
