-- Keep E2E run/case/step history (including snapshots) independent of test-member data.

-- Reuse the existing server-only purge safety checks and the same QA provenance predicate

-- already used by extended QA cleanup. The legacy zero-argument RPCs stay available.

CREATE OR REPLACE FUNCTION public.admin_purge_test_data(p_keep_history boolean)
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

  if not p_keep_history then
    delete from public.automation_test_runs
     where environment = 'MemberWebsocket-dev';
    get diagnostics v_automation_run_count = row_count;
  end if;

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
   where public.is_qa_test_provenance(c.created_by)
     and not exists (
       select 1
         from public.event_ticket_claims claim
        where claim.event_ticket_id = c.source_event_ticket_id
          and not (claim.member_id = any(v_test_member_ids))
     );
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.event_tickets e
   where public.is_qa_test_provenance(e.created_by)
     and not exists (select 1 from public.event_ticket_claims c where c.event_ticket_id = e.id)
     and not exists (select 1 from public.fixed_ticket_grants g where g.event_ticket_id = e.id)
     and not exists (select 1 from public.member_referrals r where r.reward_event_ticket_id = e.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.point_cards pc
   where public.is_qa_test_provenance(pc.created_by)
     and not exists (select 1 from public.point_entries e where e.point_card_id = pc.id)
     and not exists (select 1 from public.point_tickets t where t.point_card_id = pc.id)
     and not exists (select 1 from public.point_balances b where b.point_card_id = pc.id)
     and not exists (select 1 from public.point_transfers t where t.point_card_id = pc.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.ticket_templates tt
   where public.is_qa_test_provenance(tt.created_by)
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
    'deletedBirthdayBenefitGrants', 0,
    'deletedSessions', v_session_count,
    'deletedPresenceSessions', v_presence_count,
    'deletedAuditRows', v_audit_count,
    'deletedIdempotencyRows', v_idempotency_count,
    'deletedRateLimitRows', v_rate_limit_count,
    'deletedScheduledMessages', v_scheduled_message_count,
    'deletedQaArtifacts', v_qa_artifact_count
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_purge_all_test_data(p_keep_history boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  v_base := public.admin_purge_test_data(p_keep_history);

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

  if not p_keep_history then
    delete from public.e2e_evolution_state
     where id = true;
    get diagnostics v_evolution = row_count;
  end if;

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

CREATE OR REPLACE FUNCTION public.admin_purge_all_test_data_converged(p_keep_history boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_result jsonb := '{}'::jsonb;
  v_pass jsonb := '{}'::jsonb;
  v_pass_deleted integer := 0;
  v_retry_deleted integer := 0;
  v_passes integer := 0;
  v_remaining integer := 0;
begin
  perform pg_advisory_xact_lock(2026092001);
  perform pg_advisory_xact_lock(2026092202);

  delete from public.test_execution_leases
   where expires_at <= clock_timestamp()
      or last_heartbeat_at < clock_timestamp() - interval '90 seconds';

  v_result := public.admin_purge_all_test_data(p_keep_history);

  for v_passes in 1..4 loop
    v_pass := public.admin_purge_extended_qa_artifacts();
    v_pass_deleted := coalesce((v_pass ->> 'deletedExtendedQaArtifacts')::integer, 0);
    v_retry_deleted := v_retry_deleted + v_pass_deleted;
    exit when v_pass_deleted = 0;
  end loop;

  select
      (select count(*) from public.point_cards pc where public.is_qa_test_provenance(pc.created_by))
    + (select count(*) from public.ticket_templates tt where public.is_qa_test_provenance(tt.created_by))
    + (select count(*) from public.fixed_ticket_templates f where public.is_qa_test_provenance(f.created_by))
    + (select count(*) from public.calendar_items c where public.is_qa_test_provenance(c.created_by))
    + (select count(*) from public.booking_services bs where public.is_qa_test_provenance(bs.created_by))
    + (select count(*) from public.booking_service_types bst where public.is_qa_test_provenance(bst.created_by))
    + (select count(*) from public.booking_technicians bt where public.is_qa_test_provenance(bt.created_by))
    + (select count(*) from public.event_tickets e
         where public.is_qa_test_provenance(e.created_by)
            or exists (
              select 1 from public.fixed_ticket_templates f
               where f.id = e.fixed_ticket_template_id
                 and public.is_qa_test_provenance(f.created_by)
            ))
  into v_remaining;

  return v_result || jsonb_build_object(
    'convergencePasses', v_passes,
    'deletedConvergenceRows', v_retry_deleted,
    'remainingQaArtifacts', v_remaining,
    'cleanupComplete', v_remaining = 0
  );
end
$function$;

CREATE OR REPLACE FUNCTION public.admin_recycle_e2e_runtime(p_lease_id uuid, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
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
  v_session_count integer := 0;
  v_presence_count integer := 0;
  v_audit_count integer := 0;
  v_idempotency_count integer := 0;
  v_rate_limit_count integer := 0;
  v_scheduled_message_count integer := 0;
  v_qa_artifact_count integer := 0;
  v_rows integer := 0;
  v_old_receipts integer := 0;
  v_old_consents integer := 0;
  v_pass integer := 0;
  v_pass_result jsonb := '{}'::jsonb;
  v_extended_deleted integer := 0;
  v_service_types_deleted integer := 0;
  v_remaining integer := 0;
  v_recycled_at timestamptz;
begin
  perform pg_advisory_xact_lock(2026092001);
  perform pg_advisory_xact_lock(2026092202);

  -- Only the currently authenticated admin's active E2E lease may reset data.
  select runtime_recycled_at into v_recycled_at
    from public.test_execution_leases
   where id = p_lease_id
     and lease_type = 'full_e2e'
     and actor_line_user_id = p_actor
     and expires_at > clock_timestamp()
   for update;
  if not found then
    raise exception 'E2E_RECYCLE_LEASE_INVALID';
  end if;
  if v_recycled_at is not null then

  return jsonb_build_object('alreadyRecycled', true, 'cleanupComplete', true);
  end if;
  if exists (
    select 1 from public.test_execution_leases
     where id <> p_lease_id and lease_type = 'full_e2e'
       and expires_at > clock_timestamp()
  ) then
    raise exception 'E2E_RECYCLE_OTHER_RUN_ACTIVE';
  end if;
  if exists (
    select 1 from public.automation_test_runs
     where environment = 'MemberWebsocket-dev' and status in ('queued','running')
  ) then
    raise exception 'E2E_RECYCLE_BACKEND_RUN_ACTIVE';
  end if;

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

  delete from public.booking_receipts
   where member_id = any(v_test_member_ids);
  get diagnostics v_old_receipts = row_count;

  delete from public.membership_consents
   where member_id = any(v_test_member_ids);
  get diagnostics v_old_consents = row_count;

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

  -- Keep automation_test_runs/cases/steps and adaptive-learning history.
  -- Only test-member operational data and QA fixture assets are recycled.

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
   where public.is_qa_test_provenance(c.created_by)
     and not exists (
       select 1
         from public.event_ticket_claims claim
        where claim.event_ticket_id = c.source_event_ticket_id
          and not (claim.member_id = any(v_test_member_ids))
     );
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.event_tickets e
   where public.is_qa_test_provenance(e.created_by)
     and not exists (select 1 from public.event_ticket_claims c where c.event_ticket_id = e.id)
     and not exists (select 1 from public.fixed_ticket_grants g where g.event_ticket_id = e.id)
     and not exists (select 1 from public.member_referrals r where r.reward_event_ticket_id = e.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.point_cards pc
   where public.is_qa_test_provenance(pc.created_by)
     and not exists (select 1 from public.point_entries e where e.point_card_id = pc.id)
     and not exists (select 1 from public.point_tickets t where t.point_card_id = pc.id)
     and not exists (select 1 from public.point_balances b where b.point_card_id = pc.id)
     and not exists (select 1 from public.point_transfers t where t.point_card_id = pc.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.ticket_templates tt
   where public.is_qa_test_provenance(tt.created_by)
     and not exists (select 1 from public.point_card_rewards r where r.ticket_template_id = tt.id)
     and not exists (select 1 from public.point_tickets t where t.ticket_template_id = tt.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  -- The extended pass removes QA-owned parent fixtures after test-member
  -- ticket/point/booking references have been cleared above.
  for v_pass in 1..4 loop
    v_pass_result := public.admin_purge_extended_qa_artifacts();
    v_rows := coalesce((v_pass_result ->> 'deletedExtendedQaArtifacts')::integer, 0);
    v_extended_deleted := v_extended_deleted + v_rows;
    exit when v_rows = 0;
  end loop;

  delete from public.booking_service_types t
   where public.is_qa_test_provenance(t.created_by)
     and not exists (select 1 from public.booking_service_type_rewards r where r.service_type_id = t.id)
     and not exists (select 1 from public.booking_services s where lower(btrim(s.service_type)) = lower(btrim(t.name)));
  get diagnostics v_service_types_deleted = row_count;

  select
      (select count(*) from public.point_cards pc where public.is_qa_test_provenance(pc.created_by))
    + (select count(*) from public.ticket_templates tt where public.is_qa_test_provenance(tt.created_by))
    + (select count(*) from public.fixed_ticket_templates ft where public.is_qa_test_provenance(ft.created_by))
    + (select count(*) from public.calendar_items ci where public.is_qa_test_provenance(ci.created_by))
    + (select count(*) from public.booking_services bs where public.is_qa_test_provenance(bs.created_by))
    + (select count(*) from public.booking_service_types bst where public.is_qa_test_provenance(bst.created_by))
    + (select count(*) from public.booking_technicians bt where public.is_qa_test_provenance(bt.created_by))
    + (select count(*) from public.event_tickets et where public.is_qa_test_provenance(et.created_by))
    into v_remaining;

  -- Do not create another run on top of residual QA assets: roll back atomically.
  if v_remaining <> 0 then
    raise exception 'E2E_RECYCLE_QA_ARTIFACTS_REMAIN: %', v_remaining;
  end if;

  update public.test_execution_leases
     set runtime_recycled_at = clock_timestamp()
   where id = p_lease_id and actor_line_user_id = p_actor;

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
    'deletedBirthdayBenefitGrants', 0,
    'deletedSessions', v_session_count,
    'deletedPresenceSessions', v_presence_count,
    'deletedAuditRows', v_audit_count,
    'deletedIdempotencyRows', v_idempotency_count,
    'deletedRateLimitRows', v_rate_limit_count,
    'deletedScheduledMessages', v_scheduled_message_count,
    'deletedQaArtifacts', v_qa_artifact_count,
    'deletedQaExtendedArtifacts', v_extended_deleted,
    'deletedQaServiceTypes', v_service_types_deleted,
    'deletedBookingReceipts', v_old_receipts,
    'deletedMembershipConsents', v_old_consents,
    'remainingQaArtifacts', v_remaining,
    'cleanupComplete', true,
    'alreadyRecycled', false
  );
end;
$function$;

revoke all on function public.admin_purge_test_data(boolean) from public, anon, authenticated;
grant execute on function public.admin_purge_test_data(boolean) to service_role;
revoke all on function public.admin_purge_all_test_data(boolean) from public, anon, authenticated;
grant execute on function public.admin_purge_all_test_data(boolean) to service_role;
revoke all on function public.admin_purge_all_test_data_converged(boolean) from public, anon, authenticated;
grant execute on function public.admin_purge_all_test_data_converged(boolean) to service_role;
revoke all on function public.admin_recycle_e2e_runtime(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_recycle_e2e_runtime(uuid, text) to service_role;
