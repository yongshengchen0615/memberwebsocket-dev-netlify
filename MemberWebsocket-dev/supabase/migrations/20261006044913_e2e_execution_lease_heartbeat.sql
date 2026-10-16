begin;

alter table public.test_execution_leases
  add column if not exists last_heartbeat_at timestamptz not null default clock_timestamp();

update public.test_execution_leases
   set last_heartbeat_at = coalesce(last_heartbeat_at, created_at, clock_timestamp());

create index if not exists test_execution_leases_last_heartbeat_idx
  on public.test_execution_leases(last_heartbeat_at);

create or replace function public.admin_acquire_test_execution_lease(
  p_actor text,
  p_ttl_minutes integer default 1
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor text := left(btrim(coalesce(p_actor,'')), 180);
  v_ttl integer := greatest(1, least(120, coalesce(p_ttl_minutes, 1)));
  v_id uuid;
begin
  if v_actor = '' then
    raise exception 'TEST_EXECUTION_ACTOR_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(2026092001);
  perform pg_advisory_xact_lock(2026092202);

  delete from public.test_execution_leases
   where expires_at <= clock_timestamp();

  insert into public.test_execution_leases(
    lease_type, actor_line_user_id, expires_at, last_heartbeat_at
  )
  values (
    'full_e2e', v_actor,
    clock_timestamp() + make_interval(mins => v_ttl),
    clock_timestamp()
  )
  returning id into v_id;

  return v_id;
end
$function$;

create or replace function public.admin_heartbeat_test_execution_lease(
  p_lease_id uuid,
  p_actor text,
  p_ttl_minutes integer default 1
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_ttl integer := greatest(1, least(120, coalesce(p_ttl_minutes, 1)));
  v_updated integer := 0;
begin
  update public.test_execution_leases
     set last_heartbeat_at = clock_timestamp(),
         expires_at = clock_timestamp() + make_interval(mins => v_ttl)
   where id = p_lease_id
     and lease_type = 'full_e2e'
     and actor_line_user_id = left(btrim(coalesce(p_actor,'')), 180)
     and expires_at > clock_timestamp();

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end
$function$;

revoke all on function public.admin_heartbeat_test_execution_lease(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.admin_heartbeat_test_execution_lease(uuid, text, integer)
  to service_role;

revoke all on function public.admin_acquire_test_execution_lease(text, integer)
  from public, anon, authenticated;
grant execute on function public.admin_acquire_test_execution_lease(text, integer)
  to service_role;

comment on column public.test_execution_leases.last_heartbeat_at is
  'Last server-confirmed heartbeat for a live full E2E browser runner.';

comment on function public.admin_heartbeat_test_execution_lease(uuid, text, integer) is
  'Renews an actor-owned full E2E execution lease; abandoned runners naturally expire.';

commit;
