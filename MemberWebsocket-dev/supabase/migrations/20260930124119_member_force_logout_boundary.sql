alter table public.members
  add column if not exists force_logout_after timestamptz;

create index if not exists idx_members_force_logout_after
  on public.members(force_logout_after)
  where force_logout_after is not null;

comment on column public.members.force_logout_after is
  'Server-side revocation boundary for member LINE ID tokens. Tokens issued at or before this timestamp are rejected.';
