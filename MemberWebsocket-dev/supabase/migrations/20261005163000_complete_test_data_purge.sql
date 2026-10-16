begin;

-- Test-data cleanup provenance and execution lease.
-- QA ownership must be server-written; display names are used only once below to
-- backfill rows created by the historical E2E fixture generator.
alter table public.booking_service_types
  add column if not exists created_by text;

create index if not exists booking_service_types_created_by_idx
  on public.booking_service_types(created_by);

update public.booking_service_types
   set created_by = 'qa:e2e:legacy'
 where created_by is null
   and (
     (name ~ '^E2E QA 基礎服務 PAIR-[A-Z0-9]+-[0-9]{4}$' and sort_order = 901)
     or (name ~ '^E2E QA 加購服務 PAIR-[A-Z0-9]+-[0-9]{4}$' and sort_order = 902)
     or (name ~ '^E2E QA 長時數服務 PAIR-[A-Z0-9]+-[0-9]{4}$' and sort_order = 903)
   );

create table if not exists public.test_execution_leases (
  id uuid primary key default gen_random_uuid(),
  lease_type text not null check (lease_type in ('full_e2e')),
  actor_line_user_id text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.test_execution_leases enable row level security;
revoke all on table public.test_execution_leases from public, anon, authenticated;
grant select, insert, update, delete on table public.test_execution_leases to service_role;

create index if not exists test_execution_leases_expires_at_idx
  on public.test_execution_leases(expires_at);

create or replace function public.admin_acquire_test_execution_lease(
  p_actor text,
  p_ttl_minutes integer default 60
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor text := left(btrim(coalesce(p_actor,'')), 180);
  v_ttl integer := greatest(5, least(120, coalesce(p_ttl_minutes, 60)));
  v_id uuid;
begin
  if v_actor = '' then
    raise exception 'TEST_EXECUTION_ACTOR_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(2026092001);
  perform pg_advisory_xact_lock(2026092202);

  delete from public.test_execution_leases
   where expires_at <= clock_timestamp();

  insert into public.test_execution_leases(lease_type, actor_line_user_id, expires_at)
  values ('full_e2e', v_actor, clock_timestamp() + make_interval(mins => v_ttl))
  returning id into v_id;

  return v_id;
end
$function$;

create or replace function public.admin_release_test_execution_lease(
  p_lease_id uuid,
  p_actor text
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_deleted integer := 0;
begin
  delete from public.test_execution_leases
   where id = p_lease_id
     and actor_line_user_id = left(btrim(coalesce(p_actor,'')), 180);
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end
$function$;

-- Atomic compatibility wrapper around the existing fixture generator.
-- The legacy generator creates service types by deterministic names. Mark those
-- rows with immutable QA provenance before the same DB transaction can commit.
create or replace function public.admin_prepare_complex_e2e_fixtures_v2(
  p_run_tag text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_tag text;
  v_created_by text;
  v_marked integer := 0;
begin
  perform pg_advisory_xact_lock(2026092202);

  v_result := public.admin_prepare_complex_e2e_fixtures(p_run_tag, p_actor);
  v_tag := coalesce(v_result ->> 'runTag', '');
  v_created_by := coalesce(v_result ->> 'createdBy', '');

  if v_tag = '' or v_created_by not like 'qa:e2e:%' then
    raise exception 'E2E_SERVICE_TYPE_PROVENANCE_INVALID';
  end if;

  update public.booking_service_types
     set created_by = v_created_by
   where created_by is null
     and (
       (name = 'E2E QA 基礎服務 ' || v_tag and sort_order = 901)
       or (name = 'E2E QA 加購服務 ' || v_tag and sort_order = 902)
       or (name = 'E2E QA 長時數服務 ' || v_tag and sort_order = 903)
     );
  get diagnostics v_marked = row_count;

  if v_marked <> 3 then
    raise exception 'E2E_SERVICE_TYPE_PROVENANCE_INCOMPLETE';
  end if;

  return v_result || jsonb_build_object('bookingServiceTypesMarked', v_marked);
end
$function$;

-- One transactional cleanup boundary for every DB-backed test artifact.
create or replace function public.admin_purge_all_test_data()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_test_member_ids uuid[] := array[]::uuid[];
  v_base jsonb := '{}'::jsonb;
  v_extended jsonb := '{}'::jsonb;
  v_receipts integer := 0;
  v_consents integer := 0;
  v_service_types integer := 0;
  v_second_pass_technicians integer := 0;
  v_evolution integer := 0;
  v_extended_total integer := 0;
  v_extended_technicians integer := 0;
begin
  perform pg_advisory_xact_lock(2026092001);
  perform pg_advisory_xact_lock(2026092202);

  delete from public.test_execution_leases
   where expires_at <= clock_timestamp();

  if exists (
    select 1
      from public.test_execution_leases
     where expires_at > clock_timestamp()
  ) then
    raise exception 'TEST_EXECUTION_ACTIVE';
  end if;

  if exists (
    select 1
      from public.automation_test_runs
     where environment = 'MemberWebsocket-dev'
       and status in ('queued','running')
  ) then
    raise exception 'TEST_RUN_ACTIVE';
  end if;

  select coalesce(array_agg(id order by id), array[]::uuid[])
    into v_test_member_ids
    from public.members
   where is_test_account = true;

  delete from public.booking_receipts
   where member_id = any(v_test_member_ids);
  get diagnostics v_receipts = row_count;

  delete from public.membership_consents
   where member_id = any(v_test_member_ids);
  get diagnostics v_consents = row_count;

  v_base := public.admin_purge_test_data();
  v_extended := public.admin_purge_extended_qa_artifacts();

  delete from public.booking_service_types t
   where t.created_by like 'qa:e2e:%'
     and not exists (
       select 1
         from public.booking_service_type_rewards r
        where r.service_type_id = t.id
     )
     and not exists (
       select 1
         from public.booking_services s
        where lower(btrim(s.service_type)) = lower(btrim(t.name))
     );
  get diagnostics v_service_types = row_count;

  -- A second safe pass catches a QA technician that became unreferenced while
  -- the extended cleanup restored the formal primary-technician baseline.
  delete from public.booking_technicians t
   where t.created_by like 'qa:e2e:%'
     and not exists (select 1 from public.bookings b where b.technician_id = t.id)
     and not exists (select 1 from public.booking_participants p where p.technician_id = t.id)
     and not exists (select 1 from public.booking_participant_reservations r where r.technician_id = t.id)
     and not exists (select 1 from public.booking_settings bs where bs.primary_technician_id = t.id);
  get diagnostics v_second_pass_technicians = row_count;

  delete from public.e2e_evolution_state;
  get diagnostics v_evolution = row_count;

  v_extended_total := coalesce((v_extended ->> 'deletedExtendedQaArtifacts')::integer, 0)
    + v_service_types + v_second_pass_technicians;
  v_extended_technicians := coalesce((v_extended ->> 'deletedBookingTechnicians')::integer, 0)
    + v_second_pass_technicians;

  v_extended := v_extended || jsonb_build_object(
    'deletedBookingServiceTypes', v_service_types,
    'deletedBookingTechnicians', v_extended_technicians,
    'deletedExtendedQaArtifacts', v_extended_total
  );

  return v_base
    || v_extended
    || jsonb_build_object(
      'deletedBookingReceipts', v_receipts,
      'deletedMembershipConsents', v_consents,
      'deletedEvolutionStateRows', v_evolution
    );
end
$function$;

revoke all on function public.admin_acquire_test_execution_lease(text, integer) from public, anon, authenticated;
grant execute on function public.admin_acquire_test_execution_lease(text, integer) to service_role;
revoke all on function public.admin_release_test_execution_lease(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_release_test_execution_lease(uuid, text) to service_role;
revoke all on function public.admin_prepare_complex_e2e_fixtures_v2(text, text) from public, anon, authenticated;
grant execute on function public.admin_prepare_complex_e2e_fixtures_v2(text, text) to service_role;
revoke all on function public.admin_purge_all_test_data() from public, anon, authenticated;
grant execute on function public.admin_purge_all_test_data() to service_role;

comment on column public.booking_service_types.created_by is
  'Server-written provenance. qa:e2e:* marks disposable E2E fixture service types.';
comment on table public.test_execution_leases is
  'Short-lived server-only leases preventing test-data purge while a full browser E2E is executing.';
comment on function public.admin_purge_all_test_data() is
  'Atomic DB purge boundary for reusable test accounts, generated QA fixtures, receipts, legal consent fixtures and E2E history.';

commit;
