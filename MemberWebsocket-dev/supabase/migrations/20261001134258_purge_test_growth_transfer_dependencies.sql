CREATE OR REPLACE FUNCTION public.admin_delete_test_accounts(p_member_ids uuid[])
 RETURNS TABLE(deleted_account_count integer, total_test_accounts integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_requested_count integer := coalesce(cardinality(p_member_ids), 0);
  v_distinct_count integer := 0;
  v_matched_count integer := 0;
  v_deleted_count integer := 0;
  v_remaining_count integer := 0;
  v_line_user_ids text[] := array[]::text[];
  v_member_codes text[] := array[]::text[];
  v_member_id_texts text[] := array[]::text[];
  v_booking_ids uuid[] := array[]::uuid[];
  v_booking_id_texts text[] := array[]::text[];
begin
  if v_requested_count < 1 or v_requested_count > 200 then
    raise exception 'INVALID_TEST_ACCOUNT_DELETE_COUNT';
  end if;

  select count(distinct member_id)::integer
    into v_distinct_count
    from unnest(p_member_ids) as requested(member_id);

  if v_distinct_count <> v_requested_count then
    raise exception 'DUPLICATE_TEST_ACCOUNT_ID';
  end if;

  perform pg_advisory_xact_lock(2026092001);

  perform id
    from public.members
   where id = any(p_member_ids)
   for update;

  select
    count(*)::integer,
    coalesce(array_agg(line_user_id order by id) filter (where line_user_id is not null), array[]::text[]),
    coalesce(array_agg(member_code order by id) filter (where member_code is not null), array[]::text[]),
    coalesce(array_agg(id::text order by id), array[]::text[])
  into
    v_matched_count,
    v_line_user_ids,
    v_member_codes,
    v_member_id_texts
  from public.members
  where id = any(p_member_ids)
    and is_test_account = true;

  if v_matched_count <> v_requested_count then
    raise exception 'INVALID_TEST_ACCOUNT_SELECTION';
  end if;

  select
    coalesce(array_agg(id order by id), array[]::uuid[]),
    coalesce(array_agg(id::text order by id), array[]::text[])
  into
    v_booking_ids,
    v_booking_id_texts
  from public.bookings
  where member_id = any(p_member_ids);

  if exists (
    select 1
      from public.point_transfers t
      join public.members sender on sender.id = t.sender_member_id
      join public.members receiver on receiver.id = t.receiver_member_id
     where (t.sender_member_id = any(p_member_ids) or t.receiver_member_id = any(p_member_ids))
       and (sender.is_test_account is not true or receiver.is_test_account is not true)
  ) then
    raise exception 'TEST_DATA_CROSS_BOUNDARY_POINT_TRANSFER';
  end if;

  if exists (
    select 1
      from public.member_referrals r
      join public.members inviter on inviter.id = r.inviter_member_id
      join public.members invitee on invitee.id = r.invitee_member_id
     where (r.inviter_member_id = any(p_member_ids) or r.invitee_member_id = any(p_member_ids))
       and (inviter.is_test_account is not true or invitee.is_test_account is not true)
  ) then
    raise exception 'TEST_DATA_CROSS_BOUNDARY_REFERRAL';
  end if;

  delete from public.api_rate_limits
   where principal_hash = any (
     select encode(extensions.digest(line_user_id, 'sha256'), 'hex')
     from unnest(v_line_user_ids) as ids(line_user_id)
   );

  delete from public.idempotency_results
   where actor_line_user_id = any(v_line_user_ids)
      or exists (
        select 1
        from unnest(v_member_id_texts || v_member_codes || v_booking_id_texts || v_line_user_ids) as ids(value)
        where result::text like '%' || value || '%'
      );

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

  delete from booking_notifications.outbox
   where booking_id = any(v_booking_ids);

  delete from public.booking_completion_settlements
   where member_id = any(p_member_ids)
      or booking_id = any(v_booking_ids);

  delete from public.member_referrals
   where inviter_member_id = any(p_member_ids)
      or invitee_member_id = any(p_member_ids);

  delete from public.point_transfers
   where sender_member_id = any(p_member_ids)
      or receiver_member_id = any(p_member_ids);

  delete from public.birthday_benefit_grants
   where member_id = any(p_member_ids);

  delete from public.event_ticket_claims
   where member_id = any(p_member_ids);

  delete from public.scheduled_grant_messages
   where member_id = any(p_member_ids)
      or line_user_id = any(v_line_user_ids);

  delete from public.point_tickets
   where member_id = any(p_member_ids);

  delete from public.point_entries
   where member_id = any(p_member_ids);

  delete from public.point_balances
   where member_id = any(p_member_ids);

  delete from public.service_time_entries
   where member_id = any(p_member_ids);

  delete from public.fixed_ticket_grants
   where member_id = any(p_member_ids);

  delete from public.bookings
   where member_id = any(p_member_ids);

  delete from public.test_login_sessions
   where member_id = any(p_member_ids);

  delete from public.members
   where id = any(p_member_ids)
     and is_test_account = true;

  get diagnostics v_deleted_count = row_count;

  if v_deleted_count <> v_requested_count then
    raise exception 'TEST_ACCOUNT_DELETE_MISMATCH';
  end if;

  select count(*)::integer
    into v_remaining_count
  from public.members
  where is_test_account = true;

  if v_remaining_count = 0 then
    perform setval('public.test_member_sequence', 1, false);
  end if;

  return query
  select v_deleted_count, v_remaining_count;
end;
$function$;

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
   where (
          c.created_by like 'qa:%'
       or c.calendar_item_id like 'QA-%'
       or c.title like 'E2E QA %'
       or c.title like 'QA %'
   )
     and not exists (
       select 1
         from public.event_ticket_claims claim
        where claim.event_ticket_id = c.source_event_ticket_id
          and not (claim.member_id = any(v_test_member_ids))
     );
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.event_tickets e
   where (
          e.created_by like 'qa:%'
       or e.event_ticket_id like 'QA-%'
       or e.title like 'E2E QA %'
       or e.title like 'QA %'
   )
     and not exists (select 1 from public.event_ticket_claims c where c.event_ticket_id = e.id)
     and not exists (select 1 from public.fixed_ticket_grants g where g.event_ticket_id = e.id)
     and not exists (select 1 from public.birthday_benefit_grants g where g.event_ticket_id = e.id)
     and not exists (select 1 from public.member_referrals r where r.reward_event_ticket_id = e.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.point_cards pc
   where (
          pc.created_by like 'qa:%'
       or pc.card_id like 'QA-%'
       or pc.title like 'E2E QA %'
       or pc.title like 'QA %'
   )
     and not exists (select 1 from public.point_entries e where e.point_card_id = pc.id)
     and not exists (select 1 from public.point_tickets t where t.point_card_id = pc.id)
     and not exists (select 1 from public.point_balances b where b.point_card_id = pc.id)
     and not exists (select 1 from public.point_transfers t where t.point_card_id = pc.id);
  get diagnostics v_rows = row_count;
  v_qa_artifact_count := v_qa_artifact_count + v_rows;

  delete from public.ticket_templates tt
   where (
          tt.created_by like 'qa:%'
       or tt.ticket_template_id like 'QA-%'
       or tt.title like 'E2E QA %'
       or tt.title like 'QA %'
   )
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
$function$;