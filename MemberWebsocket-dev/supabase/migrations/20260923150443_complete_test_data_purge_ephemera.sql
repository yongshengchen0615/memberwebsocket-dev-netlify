create or replace function public.admin_purge_extended_qa_artifacts()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_fixed int := 0;
  v_services int := 0;
  v_types int := 0;
  v_technicians int := 0;
  v_rewards int := 0;
  v_fixture_audits int := 0;
  v_realtime_events int := 0;
begin
  update public.booking_settings bs
     set primary_technician_id = null,
         updated_by = 'qa:e2e:purge',
         updated_at = clock_timestamp()
   where bs.id = 1
     and exists (
       select 1
         from public.booking_technicians t
        where t.id = bs.primary_technician_id
          and t.created_by like 'qa:e2e:%'
     );

  delete from public.booking_service_type_rewards r
   where r.created_by like 'qa:%'
      or r.updated_by like 'qa:%';
  get diagnostics v_rewards = row_count;

  delete from public.booking_services s
   where s.created_by like 'qa:e2e:%'
     and not exists (select 1 from public.bookings b where b.service_id = s.id)
     and not exists (select 1 from public.booking_items bi where bi.service_id = s.id)
     and not exists (select 1 from public.booking_participant_items bpi where bpi.service_id = s.id);
  get diagnostics v_services = row_count;

  delete from public.booking_service_types t
   where t.name like 'E2E QA %'
     and not exists (
       select 1 from public.booking_services s
        where s.service_type = t.name
          and s.deleted_at is null
     );
  get diagnostics v_types = row_count;

  delete from public.booking_technicians t
   where t.created_by like 'qa:e2e:%'
     and not exists (select 1 from public.bookings b where b.technician_id = t.id)
     and not exists (select 1 from public.booking_participants p where p.technician_id = t.id)
     and not exists (select 1 from public.booking_participant_reservations r where r.technician_id = t.id)
     and not exists (select 1 from public.booking_settings bs where bs.primary_technician_id = t.id);
  get diagnostics v_technicians = row_count;

  delete from public.fixed_ticket_templates f
   where (f.created_by like 'qa:e2e:%' or f.title like 'E2E QA %')
     and not exists (select 1 from public.event_tickets e where e.fixed_ticket_template_id = f.id)
     and not exists (select 1 from public.fixed_ticket_grants g where g.fixed_ticket_template_id = f.id);
  get diagnostics v_fixed = row_count;

  delete from public.audit_logs a
   where a.action = 'test_control.fixture.prepare'
      or a.target_type = 'e2e_fixture'
      or coalesce(a.detail ->> 'createdBy', '') like 'qa:e2e:%';
  get diagnostics v_fixture_audits = row_count;

  delete from public.realtime_events r
   where r.event_type like 'test_mode.%'
      or r.event_type like 'member-record.db.automation_test_%';
  get diagnostics v_realtime_events = row_count;

  perform maintenance.ensure_required_system_baseline();

  return jsonb_build_object(
    'deletedFixedTicketTemplates', v_fixed,
    'deletedBookingServices', v_services,
    'deletedBookingServiceTypes', v_types,
    'deletedBookingTechnicians', v_technicians,
    'deletedBookingServiceTypeRewards', v_rewards,
    'deletedFixtureAuditRows', v_fixture_audits,
    'deletedTestRealtimeEvents', v_realtime_events,
    'deletedExtendedQaArtifacts',
      v_fixed + v_services + v_types + v_technicians + v_rewards + v_fixture_audits + v_realtime_events
  );
end
$function$;

revoke all on function public.admin_purge_extended_qa_artifacts()
  from public, anon, authenticated;
grant execute on function public.admin_purge_extended_qa_artifacts()
  to service_role;

comment on function public.admin_purge_extended_qa_artifacts() is
  'Admin-only cleanup for QA fixtures, test-only realtime/audit artifacts, and booking baseline restoration. Storage objects are removed by test-control-api through the Storage API.';
