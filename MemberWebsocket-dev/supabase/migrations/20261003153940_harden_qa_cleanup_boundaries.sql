begin;

-- Destructive QA cleanup must use server-written provenance, never display
-- names or public identifiers. Preserve configured production booking settings.
CREATE OR REPLACE FUNCTION public.admin_purge_test_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_test_member_ids uuid[] := array[]::uuid[];
  v_line_user_ids text[] := array[]::text[];
  v_member_codes text[] := array[]::text[];
  v_member_id_texts text[] := array[]::text[];
  v_booking_ids uuid[] := array[]::uuid[];
  v_booking_id_texts text[] := array[]::text[];
  v_test_account_count integer := 0;
  v_automation_run_count integer := 0;
  v_booking_count integer := 0;
  v_event_claim_count integer := 0;
  v_point_entry_count integer := 0;
  v_point_ticket_count integer := 0;
  v_point_balance_count integer := 0;
  v_point_transfer_count integer := 0;
  v_member_referral_count integer := 0;
  v_service_time_count integer := 0;
  v_fixed_grant_count integer := 0;
  v_birthday_grant_count integer := 0;
  v_session_count integer := 0;
  v_presence_count integer := 0;
  v_audit_count integer := 0;
  v_idempotency_count integer := 0;
  v_rate_limit_count integer := 0;
  v_scheduled_message_count integer := 0;
  v_qa_artifact_count integer := 0;
  v_rows integer := 0;
begin
  perform pg_advisory_xact_lock(2026092001);
  perform pg_advisory_xact_lock(2026092202);

  select
    count(*)::integer,
    coalesce(array_agg(id order by id), array[]::uuid[]),
    coalesce(array_agg(id::text order by id), array[]::text[]),
    coalesce(array_agg(line_user_id order by id) filter (where line_user_id is not null), array[]::text[]),
    coalesce(array_agg(member_code order by id) filter (where member_code is not null), array[]::text[])
  into
    v_test_account_count,
    v_test_member_ids,
    v_member_id_texts,
    v_line_user_ids,
    v_member_codes
  from public.members
  where is_test_account = true;

  perform id
    from public.members
   where id = any(v_test_member_ids)
   for update;

  select
    coalesce(array_agg(id order by id), array[]::uuid[]),
    coalesce(array_agg(id::text order by id), array[]::text[])
  into v_booking_ids, v_booking_id_texts
  from public.bookings
  where member_id = any(v_test_member_ids);

  if exists (
    select 1
      from public.point_transfers t
      join public.members sender on sender.id = t.sender_member_id
      join public.members receiver on receiver.id = t.receiver_member_id
     where (t.sender_member_id = any(v_test_member_ids) or t.receiver_member_id = any(v_test_member_ids))
       and (sender.is_test_account is not true or receiver.is_test_account is not true)
  ) then
    raise exception 'TEST_DATA_CROSS_BOUNDARY_POINT_TRANSFER';
  end if;

  if exists (
    select 1
      from public.member_referrals r
      join public.members inviter on inviter.id = r.inviter_member_id
      join public.members invitee on invitee.id = r.invitee_member_id
     where (r.inviter_member_id = any(v_test_member_ids) or r.invitee_member_id = any(v_test_member_ids))
       and (inviter.is_test_account is not true or invitee.is_test_account is not true)
  ) then
    raise exception 'TEST_DATA_CROSS_BOUNDARY_REFERRAL';
  end if;

  delete from public.automation_test_runs
   where environment = 'MemberWebsocket-dev';
  get diagnostics v_automation_run_count = row_count;

  delete from public.api_rate_limits
   where principal_hash = any (
     select encode(extensions.digest(line_user_id, 'sha256'), 'hex')
       from unnest(v_line_user_ids) as ids(line_user_id)
   );
  get diagnostics v_rate_limit_count = row_count;

  delete from public.idempotency_results
   where actor_line_user_id = any(v_line_user_ids)
      or exists (
        select 1
          from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
         where result::text like '%' || value || '%'
      );
  get diagnostics v_idempotency_count = row_count;

  delete from public.booking_audit_events
   where actor_line_user_id = any(v_line_user_ids)
      or target_id = any(v_member_id_texts)
      or target_id = any(v_member_codes)
      or target_id = any(v_booking_id_texts)
      or exists (
        select 1
          from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
         where metadata::text like '%' || value || '%'
      );
  get diagnostics v_rows = row_count;
  v_audit_count := v_audit_count + v_rows;

  delete from public.audit_logs
   where actor_line_user_id = any(v_line_user_ids)
      or target_id = any(v_member_id_texts)
      or target_id = any(v_member_codes)
      or target_id = any(v_booking_id_texts)
      or exists (
        select 1
          from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
         where detail::text like '%' || value || '%'
      );
  get diagnostics v_rows = row_count;
  v_audit_count := v_audit_count + v_rows;

  delete from booking_notifications.outbox
   where booking_id = any(v_booking_ids);

  delete from public.booking_completion_settlements
   where member_id = any(v_test_member_ids)
      or booking_id = any(v_booking_ids);

  delete from public.member_referrals
   where inviter_member_id = any(v_test_member_ids)
      or invitee_member_id = any(v_test_member_ids);
  get diagnostics v_member_referral_count = row_count;

  delete from public.point_transfers
   where sender_member_id = any(v_test_member_ids)
      or receiver_member_id = any(v_test_member_ids);
  get diagnostics v_point_transfer_count = row_count;

  delete from public.birthday_benefit_grants
   where member_id = any(v_test_member_ids);
  get diagnostics v_birthday_grant_count = row_count;

  delete from public.event_ticket_claims
   where member_id = any(v_test_member_ids);
  get diagnostics v_event_claim_count = row_count;

  delete from public.scheduled_grant_messages
   where member_id = any(v_test_member_ids)
      or line_user_id = any(v_line_user_ids);
  get diagnostics v_scheduled_message_count = row_count;

  delete from public.point_tickets
   where member_id = any(v_test_member_ids);
  get diagnostics v_point_ticket_count = row_count;

  delete from public.point_entries
   where member_id = any(v_test_member_ids);
  get diagnostics v_point_entry_count = row_count;

  delete from public.point_balances
   where member_id = any(v_test_member_ids);
  get diagnostics v_point_balance_count = row_count;

  delete from public.service_time_entries
   where member_id = any(v_test_member_ids);
  get diagnostics v_service_time_count = row_count;

  delete from public.fixed_ticket_grants
   where member_id = any(v_test_member_ids);
  get diagnostics v_fixed_grant_count = row_count;

  delete from public.bookings
   where member_id = any(v_test_member_ids);
  get diagnostics v_booking_count = row_count;

  delete from public.test_login_sessions
   where member_id = any(v_test_member_ids);
  get diagnostics v_session_count = row_count;

  delete from public.member_presence_sessions
   where member_id = any(v_test_member_ids);
  get diagnostics v_presence_count = row_count;

  delete from public.calendar_items c
   where c.created_by like 'qa:%'
     and not exists (
       select 1
         from public.event_ticket_claims claim
        where claim.event_ticket_id = c.source_event_ticket_id
          and not (claim.member_id = any(v_test_member_ids))
     );
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.event_tickets e
   where e.created_by like 'qa:%'
     and not exists (select 1 from public.event_ticket_claims c where c.event_ticket_id = e.id)
     and not exists (select 1 from public.fixed_ticket_grants g where g.event_ticket_id = e.id)
     and not exists (select 1 from public.birthday_benefit_grants g where g.event_ticket_id = e.id)
     and not exists (select 1 from public.member_referrals r where r.reward_event_ticket_id = e.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.point_cards pc
   where pc.created_by like 'qa:%'
     and not exists (select 1 from public.point_entries e where e.point_card_id = pc.id)
     and not exists (select 1 from public.point_tickets t where t.point_card_id = pc.id)
     and not exists (select 1 from public.point_balances b where b.point_card_id = pc.id)
     and not exists (select 1 from public.point_transfers t where t.point_card_id = pc.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.ticket_templates tt
   where tt.created_by like 'qa:%'
     and not exists (select 1 from public.point_card_rewards r where r.ticket_template_id = tt.id)
     and not exists (select 1 from public.point_tickets t where t.ticket_template_id = tt.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  return jsonb_build_object(
    'testAccountCount', v_test_account_count,
    'deletedAutomationRuns', v_automation_run_count,
    'deletedBookings', v_booking_count,
    'deletedEventClaims', v_event_claim_count,
    'deletedPointEntries', v_point_entry_count,
    'deletedPointTickets', v_point_ticket_count,
    'deletedPointBalances', v_point_balance_count,
    'deletedPointTransfers', v_point_transfer_count,
    'deletedMemberReferrals', v_member_referral_count,
    'deletedServiceTimeEntries', v_service_time_count,
    'deletedFixedTicketGrants', v_fixed_grant_count,
    'deletedBirthdayBenefitGrants', v_birthday_grant_count,
    'deletedSessions', v_session_count,
    'deletedPresenceSessions', v_presence_count,
    'deletedAuditRows', v_audit_count,
    'deletedIdempotencyRows', v_idempotency_count,
    'deletedRateLimitRows', v_rate_limit_count,
    'deletedScheduledMessages', v_scheduled_message_count,
    'deletedQaArtifacts', v_qa_artifact_count
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_purge_extended_qa_artifacts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_fixed int := 0;
  v_services int := 0;
  v_types int := 0;
  v_technicians int := 0;
  v_rewards int := 0;
  v_fixture_audits int := 0;
  v_realtime_events int := 0;
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

  -- Service types have no immutable QA provenance. A display name is not
  -- evidence of test ownership; preserve unmarked types for explicit review.
  v_types := 0;

  delete from public.booking_technicians t
   where t.created_by like 'qa:e2e:%'
     and not exists (select 1 from public.bookings b where b.technician_id = t.id)
     and not exists (select 1 from public.booking_participants p where p.technician_id = t.id)
     and not exists (select 1 from public.booking_participant_reservations r where r.technician_id = t.id)
     and not exists (select 1 from public.booking_settings bs where bs.primary_technician_id = t.id);
  get diagnostics v_technicians = row_count;

  delete from public.fixed_ticket_templates f
   where f.created_by like 'qa:e2e:%'
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

  select primary_technician_id into v_system_primary_technician_id
    from public.booking_settings where id = 1;

  -- Provision the fallback only when no configured primary remains. Avoid
  -- changing activation/order/version metadata of existing formal settings.
  if v_system_primary_technician_id is null then
    insert into public.booking_technicians(name, is_active, sort_order, created_by)
    select '系統主要技師', true, 0, 'system'
    where not exists (
      select 1
        from public.booking_technicians t
       where lower(btrim(t.name)) = lower(btrim('系統主要技師'))
    );

    update public.booking_technicians t
       set is_active = true,
           sort_order = 0,
           updated_at = clock_timestamp()
     where lower(btrim(t.name)) = lower(btrim('系統主要技師'));

    select t.id
      into v_system_primary_technician_id
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
    'deletedBookingServices', v_services,
    'deletedBookingServiceTypes', v_types,
    'deletedBookingTechnicians', v_technicians,
    'deletedBookingServiceTypeRewards', v_rewards,
    'deletedFixtureAuditRows', v_fixture_audits,
    'deletedTestRealtimeEvents', v_realtime_events,
    'deletedExtendedQaArtifacts',
      v_fixed + v_services + v_types + v_technicians + v_rewards + v_fixture_audits + v_realtime_events,
    'restoredPrimaryTechnicianId', v_system_primary_technician_id
  );
end
$function$
;

revoke all on function public.admin_purge_test_data() from public, anon, authenticated;
grant execute on function public.admin_purge_test_data() to service_role;
revoke all on function public.admin_purge_extended_qa_artifacts() from public, anon, authenticated;
grant execute on function public.admin_purge_extended_qa_artifacts() to service_role;

comment on function public.admin_purge_test_data() is 'Manually invoked QA cleanup. Resource deletion requires server-written qa: creation provenance; names and ids alone are not sufficient.';
comment on function public.admin_purge_extended_qa_artifacts() is 'Manually invoked QA cleanup. Retains unmarked service types and preserves non-null configured primary technician.';

commit;
