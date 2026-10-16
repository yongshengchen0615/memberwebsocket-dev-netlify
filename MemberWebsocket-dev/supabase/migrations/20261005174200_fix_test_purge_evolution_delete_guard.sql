begin;

-- Preserve the current atomic test purge behavior while satisfying the database
-- delete guard for the singleton E2E evolution state. The table schema enforces
-- id = true, so this predicate is the narrowest valid cleanup boundary.
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
  v_system_primary_technician_id uuid;
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

  -- Replace a QA-owned primary directly with a non-QA baseline. Setting it to
  -- NULL is intentionally blocked by booking_settings_protect_primary_technician.
  if exists (
    select 1
      from public.booking_settings bs
      join public.booking_technicians t on t.id = bs.primary_technician_id
     where bs.id = 1
       and t.created_by like 'qa:e2e:%'
  ) then
    select t.id
      into v_system_primary_technician_id
      from public.booking_technicians t
     where lower(btrim(t.name)) = lower(btrim('系統主要技師'))
       and coalesce(t.created_by, '') not like 'qa:%'
     order by t.created_at
     limit 1;

    if v_system_primary_technician_id is null then
      insert into public.booking_technicians(name, is_active, sort_order, created_by)
      values ('系統主要技師', true, 0, 'system')
      returning id into v_system_primary_technician_id;
    else
      update public.booking_technicians
         set is_active = true,
             sort_order = 0,
             updated_at = clock_timestamp()
       where id = v_system_primary_technician_id;
    end if;

    update public.booking_settings
       set primary_technician_id = v_system_primary_technician_id,
           updated_by = 'qa:e2e:purge',
           updated_at = clock_timestamp()
     where id = 1;
  end if;

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

  delete from public.booking_technicians t
   where t.created_by like 'qa:e2e:%'
     and not exists (select 1 from public.bookings b where b.technician_id = t.id)
     and not exists (select 1 from public.booking_participants p where p.technician_id = t.id)
     and not exists (select 1 from public.booking_participant_reservations r where r.technician_id = t.id)
     and not exists (select 1 from public.booking_settings bs where bs.primary_technician_id = t.id);
  get diagnostics v_second_pass_technicians = row_count;

  delete from public.e2e_evolution_state
   where id = true;
  get diagnostics v_evolution = row_count;

  v_extended_total := coalesce((v_extended ->> 'deletedExtendedQaArtifacts')::integer, 0)
    + v_service_types + v_second_pass_technicians;
  v_extended_technicians := coalesce((v_extended ->> 'deletedBookingTechnicians')::integer, 0)
    + v_second_pass_technicians;

  v_extended := v_extended || jsonb_build_object(
    'deletedBookingServiceTypes', v_service_types,
    'deletedBookingTechnicians', v_extended_technicians,
    'deletedExtendedQaArtifacts', v_extended_total,
    'restoredPrimaryTechnicianId', v_system_primary_technician_id
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

revoke all on function public.admin_purge_all_test_data() from public, anon, authenticated;
grant execute on function public.admin_purge_all_test_data() to service_role;

commit;
