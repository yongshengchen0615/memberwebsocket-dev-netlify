create or replace function public.admin_purge_extended_qa_artifacts()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_fixed int := 0;
  v_qa_event_tickets int := 0;
  v_point_cards int := 0;
  v_ticket_templates int := 0;
  v_services int := 0;
  v_types int := 0;
  v_technicians int := 0;
  v_rewards int := 0;
  v_fixture_audits int := 0;
  v_realtime_events int := 0;
  v_rows int := 0;
  v_system_primary_technician_id uuid;
begin
  perform pg_advisory_xact_lock(2026092202);

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
   where r.created_by like 'qa:%';
  get diagnostics v_rewards = row_count;

  delete from public.booking_services s
   where s.created_by like 'qa:e2e:%'
     and not exists (select 1 from public.bookings b where b.service_id = s.id)
     and not exists (select 1 from public.booking_items bi where bi.service_id = s.id)
     and not exists (select 1 from public.booking_participant_items bpi where bpi.service_id = s.id);
  get diagnostics v_services = row_count;

  v_types := 0;

  delete from public.booking_technicians t
   where t.created_by like 'qa:e2e:%'
     and not exists (select 1 from public.bookings b where b.technician_id = t.id)
     and not exists (select 1 from public.booking_participants p where p.technician_id = t.id)
     and not exists (select 1 from public.booking_participant_reservations r where r.technician_id = t.id)
     and not exists (select 1 from public.booking_settings bs where bs.primary_technician_id = t.id);
  get diagnostics v_technicians = row_count;

  loop
    delete from public.event_tickets e
     where (
            e.created_by like 'qa:%'
         or exists (
              select 1
                from public.fixed_ticket_templates f
               where f.id = e.fixed_ticket_template_id
                 and f.created_by like 'qa:%'
            )
     )
       and not exists (select 1 from public.event_ticket_claims c where c.event_ticket_id = e.id)
       and not exists (select 1 from public.fixed_ticket_grants g where g.event_ticket_id = e.id)
       and not exists (select 1 from public.member_referrals r where r.reward_event_ticket_id = e.id)
       and not exists (select 1 from public.event_tickets child where child.referral_source_event_ticket_id = e.id);
    get diagnostics v_rows = row_count;
    v_qa_event_tickets := v_qa_event_tickets + v_rows;
    exit when v_rows = 0;
  end loop;

  delete from public.fixed_ticket_templates f
   where f.created_by like 'qa:%'
     and not exists (select 1 from public.event_tickets e where e.fixed_ticket_template_id = f.id)
     and not exists (select 1 from public.fixed_ticket_grants g where g.fixed_ticket_template_id = f.id);
  get diagnostics v_fixed = row_count;

  delete from public.point_cards pc
   where pc.created_by like 'qa:%'
     and not exists (select 1 from public.point_entries e where e.point_card_id = pc.id)
     and not exists (select 1 from public.point_tickets t where t.point_card_id = pc.id)
     and not exists (select 1 from public.point_balances b where b.point_card_id = pc.id)
     and not exists (select 1 from public.point_transfers t where t.point_card_id = pc.id);
  get diagnostics v_point_cards = row_count;

  delete from public.ticket_templates tt
   where tt.created_by like 'qa:%'
     and not exists (select 1 from public.point_card_rewards r where r.ticket_template_id = tt.id)
     and not exists (select 1 from public.point_tickets t where t.ticket_template_id = tt.id);
  get diagnostics v_ticket_templates = row_count;

  delete from public.audit_logs a
   where a.action = 'test_control.fixture.prepare'
      or a.target_type = 'e2e_fixture'
      or coalesce(a.detail ->> 'createdBy', '') like 'qa:e2e:%';
  get diagnostics v_fixture_audits = row_count;

  delete from public.realtime_events r
   where r.event_type like 'test_mode.%'
      or r.event_type like 'member-record.db.automation_test_%';
  get diagnostics v_realtime_events = row_count;

  select primary_technician_id into v_system_primary_technician_id
    from public.booking_settings where id = 1;

  if v_system_primary_technician_id is null then
    insert into public.booking_technicians(name, is_active, sort_order, created_by)
    select '系統主要技師', true, 0, 'system'
    where not exists (
      select 1 from public.booking_technicians t
       where lower(btrim(t.name)) = lower(btrim('系統主要技師'))
    );

    update public.booking_technicians t
       set is_active = true, sort_order = 0, updated_at = clock_timestamp()
     where lower(btrim(t.name)) = lower(btrim('系統主要技師'));

    select t.id into v_system_primary_technician_id
      from public.booking_technicians t
     where lower(btrim(t.name)) = lower(btrim('系統主要技師'))
       and t.is_active = true
     order by t.created_at
     limit 1;

    if v_system_primary_technician_id is null then
      raise exception 'SYSTEM_PRIMARY_TECHNICIAN_BASELINE_FAILED';
    end if;

    insert into public.booking_settings(id, primary_technician_id, updated_by)
    values (1, v_system_primary_technician_id, 'system-baseline')
    on conflict (id) do update
      set primary_technician_id = excluded.primary_technician_id,
          updated_by = excluded.updated_by,
          updated_at = clock_timestamp()
    where public.booking_settings.primary_technician_id is null;
  end if;

  return jsonb_build_object(
    'deletedFixedTicketTemplates', v_fixed,
    'deletedQaGeneratedEventTickets', v_qa_event_tickets,
    'deletedQaPointCards', v_point_cards,
    'deletedQaTicketTemplates', v_ticket_templates,
    'deletedBookingServices', v_services,
    'deletedBookingServiceTypes', v_types,
    'deletedBookingTechnicians', v_technicians,
    'deletedBookingServiceTypeRewards', v_rewards,
    'deletedFixtureAuditRows', v_fixture_audits,
    'deletedTestRealtimeEvents', v_realtime_events,
    'deletedExtendedQaArtifacts',
      v_fixed + v_qa_event_tickets + v_point_cards + v_ticket_templates
      + v_services + v_types + v_technicians + v_rewards + v_fixture_audits + v_realtime_events,
    'restoredPrimaryTechnicianId', v_system_primary_technician_id
  );
end
$function$;

revoke all on function public.admin_purge_extended_qa_artifacts()
  from public, anon, authenticated;
grant execute on function public.admin_purge_extended_qa_artifacts()
  to service_role;

comment on function public.admin_purge_extended_qa_artifacts() is
  'Admin-only cleanup for QA fixtures. Deletes dependency-safe QA point/card assets and fixed-ticket generated event rows by immutable QA provenance before removing parent templates.';
