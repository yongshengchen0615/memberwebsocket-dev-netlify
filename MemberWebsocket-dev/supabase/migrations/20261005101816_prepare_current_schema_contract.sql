-- Deploy this before the updated Edge Functions. Historical migrations stay immutable.
set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $$
begin
  if exists (select 1 from public.test_execution_leases where expires_at > clock_timestamp()) then
    raise exception 'LEGACY_CLEANUP_ACTIVE_TEST_RUN';
  end if;
  if exists (select 1 from public.birthday_benefit_grants)
     or exists (select 1 from public.birthday_benefit_settings where enabled) then
    raise exception 'LEGACY_BIRTHDAY_DATA_REQUIRES_MIGRATION';
  end if;
  if exists (select 1 from public.point_card_rewards where cardinality(required_service_types)>0 and cardinality(required_service_ids)=0)
     or exists (select 1 from public.event_tickets where cardinality(required_service_types)>0 and cardinality(required_service_ids)=0) then
    raise exception 'LEGACY_SERVICE_REQUIREMENTS_NOT_MIGRATED';
  end if;
  if exists (select 1 from public.event_tickets where requires_location and not public.event_ticket_locations_valid(redemption_locations)) then
    raise exception 'LEGACY_LOCATIONS_NOT_MIGRATED';
  end if;
  if exists (select 1 from public.event_ticket_settings where max_tickets_per_day is distinct from max_tickets_per_redemption) then
    raise exception 'LEGACY_EVENT_LIMITS_CONFLICT';
  end if;
end;
$$;

-- End the rollout translators before changing either API or stored columns.
-- The current API already converts request data to IDs and location arrays.
drop trigger if exists sync_event_ticket_required_service_types_to_ids on public.event_tickets;
drop trigger if exists sync_point_reward_required_service_types_to_ids on public.point_card_rewards;
drop trigger if exists sync_legacy_ticket_redemption_location on public.event_tickets;
alter table public.event_tickets drop constraint if exists event_tickets_redemption_location_valid;

CREATE OR REPLACE FUNCTION public.save_point_card(p_actor_line_user_id text, p_card jsonb, p_expected_updated_at timestamp with time zone)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_card_id text := nullif(trim(p_card->>'cardId'),'');
  v_id uuid;
  v_now timestamptz := now();
  v_reward jsonb;
  v_template_id uuid;
  v_threshold integer;
  v_reward_row_id uuid;
  v_matched_reward_ids uuid[] := array[]::uuid[];
  v_style_key text := lower(trim(coalesce(nullif(p_card->>'pointCardStyleKey',''), nullif(p_card->>'styleKey',''), '')));
begin
  v_style_key := case v_style_key
    when 'forest' then 'lagoon'
    when 'midnight' then 'skyline'
    when 'ocean' then 'denim'
    when 'sunset' then 'coral'
    when 'lavender' then 'violet'
    when 'rose' then 'berry'
    when 'gold' then 'citrus'
    when 'platinum' then 'cocoa'
    when 'mint' then 'lime'
    when 'cherry' then 'peach'
    else v_style_key
  end;

  if v_style_key not in ('citrus','coral','lagoon','skyline','violet','berry','cocoa','lime','denim','peach') then
    raise exception 'INVALID_POINT_CARD_STYLE';
  end if;

  if v_card_id is null then
    v_card_id := public.new_public_id('PC');
    insert into public.point_cards(
      card_id,title,status,accent,style_key,expiry_mode,expires_on,sort_order,usage_method,usage_instructions,benefit_description,
      created_by,updated_by
    ) values(
      v_card_id,trim(p_card->>'title'),p_card->>'status',p_card->>'accent',v_style_key,p_card->>'expiryMode',
      nullif(p_card->>'expiresOn','')::date,coalesce((select max(sort_order)+1 from public.point_cards),0),
      coalesce(p_card->>'usageMethod',''),coalesce(p_card->>'usageInstructions',''),coalesce(p_card->>'benefitDescription',''),
      p_actor_line_user_id,p_actor_line_user_id
    ) returning id into v_id;
  else
    select id into v_id from public.point_cards where card_id=v_card_id for update;
    if not found then raise exception 'POINT_CARD_NOT_FOUND'; end if;
    if p_expected_updated_at is not null and not exists(select 1 from public.point_cards where id=v_id and updated_at=p_expected_updated_at) then
      raise exception 'CONFLICT';
    end if;
    update public.point_cards set
      title=trim(p_card->>'title'),status=p_card->>'status',accent=p_card->>'accent',style_key=v_style_key,
      expiry_mode=p_card->>'expiryMode',expires_on=nullif(p_card->>'expiresOn','')::date,
      usage_method=coalesce(p_card->>'usageMethod',''),usage_instructions=coalesce(p_card->>'usageInstructions',''),
      benefit_description=coalesce(p_card->>'benefitDescription',''),
      updated_by=p_actor_line_user_id,updated_at=v_now
    where id=v_id;
  end if;

  if jsonb_typeof(p_card->'rewards')='array' then
    for v_reward in select value from jsonb_array_elements(p_card->'rewards')
    loop
      begin
        v_threshold := (v_reward->>'thresholdStamps')::integer;
      exception when others then
        raise exception 'INVALID_REWARD_THRESHOLD';
      end;
      if v_threshold < 1 or v_threshold > 100 then raise exception 'INVALID_REWARD_THRESHOLD'; end if;

      select id into v_template_id
      from public.ticket_templates
      where ticket_template_id=v_reward->>'ticketTemplateId';
      if not found then raise exception 'TICKET_TEMPLATE_NOT_FOUND'; end if;

      v_reward_row_id := null;
      select r.id into v_reward_row_id
      from public.point_card_rewards r
      where r.point_card_id=v_id and r.threshold_stamps=v_threshold and not (r.id = any(v_matched_reward_ids))
      limit 1 for update;

      if v_reward_row_id is null then
        select r.id into v_reward_row_id
        from public.point_card_rewards r
        where r.point_card_id=v_id and r.ticket_template_id=v_template_id and not (r.id = any(v_matched_reward_ids))
        order by r.threshold_stamps limit 1 for update;
      end if;

      if v_reward_row_id is null then
        insert into public.point_card_rewards(
          reward_id,point_card_id,threshold_stamps,ticket_template_id
        )
        values(
          public.new_public_id('RW'),v_id,v_threshold,v_template_id
        )
        returning id into v_reward_row_id;
      else
        update public.point_card_rewards
        set threshold_stamps=v_threshold,
            ticket_template_id=v_template_id,
            updated_at=v_now
        where id=v_reward_row_id;
      end if;
      v_matched_reward_ids := array_append(v_matched_reward_ids,v_reward_row_id);
    end loop;
  end if;

  if cardinality(v_matched_reward_ids)=0 then
    delete from public.point_card_rewards where point_card_id=v_id;
  else
    delete from public.point_card_rewards where point_card_id=v_id and not (id = any(v_matched_reward_ids));
  end if;

  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
  values(public.new_public_id('AUD'),p_actor_line_user_id,'admin','admin.pointcards.save','point_card',v_card_id,'success',
    jsonb_build_object(
      'stableRewardIdentity',true,
      'rewardCount',cardinality(v_matched_reward_ids),
      'styleKey',v_style_key,
      'bookingServiceRuleAtRewardNode',true
    ));
  return v_card_id;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.bind_member_referral(p_invitee_line_user_id text, p_invite_code text, p_request_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_invitee public.members%rowtype;
  v_inviter public.members%rowtype;
  v_existing public.member_referrals%rowtype;
  v_source_event public.event_tickets%rowtype;
  v_reward_event public.event_tickets%rowtype;
  v_referral_id text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_claim_id text;
  v_claim_count integer := 0;
  v_inviter_tier text;
begin
  p_invite_code := upper(btrim(coalesce(p_invite_code, '')));
  p_request_id := btrim(coalesce(p_request_id, ''));

  if p_invite_code !~ '^[A-F0-9]{10}$' then
    raise exception 'INVALID_INVITE_CODE';
  end if;
  if p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then
    raise exception 'INVALID_REQUEST_ID';
  end if;

  select * into v_invitee
  from public.members
  where line_user_id = p_invitee_line_user_id
  for update;

  if not found
     or v_invitee.status <> 'active'
     or v_invitee.membership_status <> 'active' then
    raise exception 'MEMBERSHIP_REQUIRED';
  end if;

  select * into v_existing
  from public.member_referrals
  where invitee_member_id = v_invitee.id
  for update;

  if found then
    select * into v_inviter
    from public.members
    where id = v_existing.inviter_member_id;

    if v_existing.invite_code <> p_invite_code then
      raise exception 'REFERRAL_ALREADY_BOUND';
    end if;

    return jsonb_build_object(
      'referralId', v_existing.referral_id,
      'alreadyApplied', true,
      'rewardStatus', v_existing.reward_status,
      'rewardEventTicketId', (
        select e.event_ticket_id
        from public.event_tickets e
        where e.id = v_existing.reward_event_ticket_id
      ),
      'rewardExpiresOn', (
        select e.ends_on
        from public.event_tickets e
        where e.id = v_existing.reward_event_ticket_id
      ),
      'rewardRecipient', 'inviter',
      'inviterMemberCode', v_inviter.member_code
    );
  end if;

  select * into v_inviter
  from public.members
  where invite_code = p_invite_code
    and status = 'active'
    and membership_status = 'active';

  if not found then
    raise exception 'INVITE_CODE_NOT_FOUND';
  end if;
  if v_inviter.id = v_invitee.id then
    raise exception 'SELF_REFERRAL_NOT_ALLOWED';
  end if;

  if exists (
    with recursive descendants(member_id) as (
      select r.invitee_member_id
      from public.member_referrals r
      where r.inviter_member_id = v_invitee.id
      union
      select r.invitee_member_id
      from public.member_referrals r
      join descendants d on r.inviter_member_id = d.member_id
    )
    select 1 from descendants where member_id = v_inviter.id
  ) then
    raise exception 'REFERRAL_CYCLE_NOT_ALLOWED';
  end if;

  perform 1
  from public.members
  where id in (v_inviter.id, v_invitee.id)
  order by id
  for update;

  select * into v_source_event
  from public.event_tickets
  where ticket_type = 'referral'
    and referral_source_event_ticket_id is null
    and status = 'active'
    and deleted_at is null
    and (starts_on is null or starts_on <= v_today)
    and (ends_on is null or ends_on >= v_today)
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'REFERRAL_REWARD_UNAVAILABLE';
  end if;

  v_inviter_tier := public.current_tier_key(v_inviter.id);
  if not (v_inviter_tier = any(v_source_event.allowed_tier_keys)) then
    raise exception 'REFERRAL_REWARD_NOT_ELIGIBLE';
  end if;

  if v_source_event.quota > 0 then
    select count(*)::integer into v_claim_count
    from public.event_ticket_claims c
    join public.event_tickets reward_event
      on reward_event.id = c.event_ticket_id
    where c.ticket_type = 'referral'
      and (
        c.event_ticket_id = v_source_event.id
        or reward_event.referral_source_event_ticket_id = v_source_event.id
      );

    if v_claim_count >= v_source_event.quota then
      raise exception 'REFERRAL_REWARD_SOLD_OUT';
    end if;
  end if;

  v_referral_id := public.new_public_id('RF');

  insert into public.event_tickets(
    event_ticket_id,
    title,
    ticket_type,
    description,
    usage_method,
    usage_instructions,
    prizes,
    status,
    starts_on,
    ends_on,
    quota,
    accent,
    allowed_tier_keys,
    required_service_ids,
    required_service_match_mode,
    created_by,
    updated_by,
    activity_url,
    activity_link_name,
    requires_location,
    redemption_locations,
    referral_source_event_ticket_id
  ) values (
    'REFERRAL-' || v_referral_id,
    v_source_event.title,
    'referral',
    v_source_event.description,
    v_source_event.usage_method,
    v_source_event.usage_instructions,
    v_source_event.prizes,
    'active',
    v_today,
    v_source_event.ends_on,
    1,
    v_source_event.accent,
    v_source_event.allowed_tier_keys,
    coalesce(v_source_event.required_service_ids, '{}'::uuid[]),
    coalesce(v_source_event.required_service_match_mode, 'any'),
    'member-referral',
    'member-referral',
    v_source_event.activity_url,
    v_source_event.activity_link_name,
    false,
    '[]'::jsonb,
    v_source_event.id
  )
  returning * into v_reward_event;

  insert into public.member_referrals(
    referral_id,
    inviter_member_id,
    invitee_member_id,
    invite_code,
    request_id,
    trigger_type,
    reward_status,
    reward_event_ticket_id,
    rewarded_at
  ) values (
    v_referral_id,
    v_inviter.id,
    v_invitee.id,
    p_invite_code,
    p_request_id,
    'membership_activation',
    'issued',
    v_reward_event.id,
    now()
  );

  v_claim_id := public.new_public_id('EC');
  insert into public.event_ticket_claims(
    claim_id,
    event_ticket_id,
    member_id,
    ticket_type,
    ticket_title,
    ticket_description,
    usage_method,
    usage_instructions,
    prizes,
    status,
    claimed_at
  ) values (
    v_claim_id,
    v_reward_event.id,
    v_inviter.id,
    'referral',
    v_reward_event.title,
    v_reward_event.description,
    v_reward_event.usage_method,
    v_reward_event.usage_instructions,
    v_reward_event.prizes,
    'claimed',
    now()
  );

  insert into public.audit_logs(
    audit_id,
    actor_line_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    detail
  ) values (
    public.new_public_id('AUD'),
    v_invitee.line_user_id,
    'member',
    'user.member.referral.bind',
    'member_referral',
    v_referral_id,
    'success',
    jsonb_build_object(
      'inviterMemberId', v_inviter.id,
      'inviteeMemberId', v_invitee.id,
      'trigger', 'invite_code_bind',
      'rewardRecipient', 'inviter',
      'rewardCount', 1,
      'rewardSourceEventTicketId', v_source_event.event_ticket_id,
      'rewardEventTicketId', v_reward_event.event_ticket_id,
      'rewardClaimId', v_claim_id,
      'rewardExpiresOn', v_reward_event.ends_on
    )
  );

  insert into public.realtime_events(scope,event_type)
  values ('event','member.referral.reward-issued');

  return jsonb_build_object(
    'referralId', v_referral_id,
    'alreadyApplied', false,
    'rewardStatus', 'issued',
    'rewardRecipient', 'inviter',
    'rewardEventTicketId', v_reward_event.event_ticket_id,
    'rewardExpiresOn', v_reward_event.ends_on,
    'rewardClaimId', v_claim_id,
    'inviterMemberCode', v_inviter.member_code
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.apply_fixed_ticket_location_rule()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_requires boolean;
  v_locations jsonb;
begin
  if new.fixed_ticket_template_id is null then
    return new;
  end if;

  select requires_location, redemption_locations
    into v_requires, v_locations
  from public.fixed_ticket_templates
  where id = new.fixed_ticket_template_id;

  if found then
    new.requires_location := coalesce(v_requires,false);
    new.redemption_locations := case when coalesce(v_requires,false) then coalesce(v_locations,'[]'::jsonb) else '[]'::jsonb end;
  end if;
  return new;
end;
$function$
;
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
$function$
;
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
$function$
;
CREATE OR REPLACE FUNCTION public.admin_save_maintenance_test_access(p_maintenance_enabled boolean, p_allow_pc_test_login boolean, p_allow_mobile_test_login boolean, p_maintenance_message text, p_updated_by text, p_add_account_count integer DEFAULT 0)
 RETURNS TABLE(created_account_count integer, total_test_accounts integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_count integer := coalesce(p_add_account_count, 0);
  v_message text := coalesce(p_maintenance_message, '');
  v_existing integer;
  v_seq bigint;
  v_i integer;
  v_was_maintenance boolean := false;
  v_transition_to_maintenance boolean := false;
  v_revoked_at timestamptz;
  v_surnames text[] := array['陳','林','黃','張','李','王','吳','劉','蔡','楊','許','鄭','謝','洪','郭','邱','曾','廖','賴','徐'];
  v_male_names text[] := array['志明','俊傑','冠宇','柏翰','家豪','承翰','宇翔','子豪','建宏','宗翰','彥廷','品睿'];
  v_female_names text[] := array['怡君','雅婷','欣怡','佳穎','郁婷','佩珊','詩涵','筱涵','雨柔','佳蓉','婉婷','思妤'];
  v_surname text;
  v_given_name text;
  v_salutation text;
  v_birthday date;
  v_phone text;
begin
  if v_count < 0 or v_count > 50 then
    raise exception 'INVALID_TEST_ACCOUNT_COUNT';
  end if;
  if char_length(v_message) > 500 then
    raise exception 'INVALID_MAINTENANCE_MESSAGE';
  end if;

  perform pg_advisory_xact_lock(2026092001);

  select coalesce(maintenance_enabled, false)
    into v_was_maintenance
    from public.test_mode_settings
   where id = true;

  v_transition_to_maintenance :=
    not coalesce(v_was_maintenance, false)
    and coalesce(p_maintenance_enabled, false);
  if v_transition_to_maintenance then
    v_revoked_at := clock_timestamp();
  end if;

  select count(*)::integer into v_existing
  from public.members
  where is_test_account = true;

  if v_existing + v_count > 200 then
    raise exception 'TEST_ACCOUNT_LIMIT_REACHED';
  end if;

  insert into public.test_mode_settings (
    id, maintenance_enabled,
    allow_pc_test_login, allow_mobile_test_login, maintenance_message,
    maintenance_revoked_after, updated_by, updated_at
  )
  values (
    true,
    coalesce(p_maintenance_enabled, false),
    coalesce(p_allow_pc_test_login, false),
    coalesce(p_allow_mobile_test_login, false),
    v_message,
    case when v_transition_to_maintenance then v_revoked_at else null end,
    nullif(btrim(coalesce(p_updated_by, '')), ''),
    now()
  )
  on conflict (id) do update set
    maintenance_enabled = excluded.maintenance_enabled,
    allow_pc_test_login = excluded.allow_pc_test_login,
    allow_mobile_test_login = excluded.allow_mobile_test_login,
    maintenance_message = excluded.maintenance_message,
    maintenance_revoked_after = case
      when v_transition_to_maintenance then v_revoked_at
      else public.test_mode_settings.maintenance_revoked_after
    end,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  if v_transition_to_maintenance then
    update public.test_login_sessions
       set revoked_at = coalesce(revoked_at, v_revoked_at),
           last_used_at = v_revoked_at
     where revoked_at is null;

    update public.member_presence_sessions
       set last_seen_at = v_revoked_at,
           offline_at = v_revoked_at,
           offline_reason = 'maintenance',
           updated_at = v_revoked_at
     where offline_at is null;
  elsif not coalesce(p_maintenance_enabled, false) then
    update public.test_login_sessions
       set revoked_at = coalesce(revoked_at, now())
     where revoked_at is null;
  else
    if not coalesce(p_allow_pc_test_login, false) then
      update public.test_login_sessions
         set revoked_at = coalesce(revoked_at, now())
       where revoked_at is null
         and device_class = 'pc';
    end if;
    if not coalesce(p_allow_mobile_test_login, false) then
      update public.test_login_sessions
         set revoked_at = coalesce(revoked_at, now())
       where revoked_at is null
         and device_class = 'mobile';
    end if;
  end if;

  for v_i in 1..v_count loop
    v_seq := nextval('public.test_member_sequence');
    v_salutation := case when random() < 0.5 then 'mr' else 'ms' end;
    v_surname := v_surnames[1 + floor(random() * array_length(v_surnames, 1))::int];
    if v_salutation = 'mr' then
      v_given_name := v_male_names[1 + floor(random() * array_length(v_male_names, 1))::int];
    else
      v_given_name := v_female_names[1 + floor(random() * array_length(v_female_names, 1))::int];
    end if;
    v_birthday := ((current_date - make_interval(years => 18 + floor(random() * 48)::int))::date
      - floor(random() * 365)::int);

    loop
      -- Match the same E.164 and phone-quality constraints as real members.
      v_phone := '+8869' || lpad(floor(random() * 100000000)::bigint::text, 8, '0');
      exit when v_phone !~ '([0-9])\1{6,}'
        and not exists (select 1 from public.members where phone = v_phone);
    end loop;

    insert into public.members (
      line_user_id, display_name, member_code, status, membership_status,
      birthday, phone, joined_at, last_login_at, surname, salutation,
      is_test_account, test_account_sequence, created_at, updated_at
    ) values (
      'TEST-' || replace(gen_random_uuid()::text, '-', ''),
      v_surname || v_given_name || '（測試）',
      'TST' || lpad(v_seq::text, 6, '0'),
      'active',
      'active',
      v_birthday,
      v_phone,
      now(),
      now(),
      v_surname,
      v_salutation,
      true,
      v_seq,
      now(),
      now()
    );
  end loop;

  return query
  select v_count, count(*)::integer
  from public.members
  where is_test_account = true;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.admin_prepare_complex_e2e_fixtures(p_run_tag text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_tag text := upper(regexp_replace(coalesce(p_run_tag,''), '[^A-Za-z0-9_-]', '', 'g'));
  v_created_by text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_coupon1 uuid;
  v_coupon2 uuid;
  v_lottery1 uuid;
  v_lottery2 uuid;
  v_card1 uuid;
  v_card2 uuid;
  v_type1 uuid;
  v_type2 uuid;
  v_type3 uuid;
  v_ticket_count int := 0;
  v_card_count int := 0;
  v_reward_count int := 0;
  v_event_count int := 0;
  v_calendar_count int := 0;
  v_fixed_count int := 0;
  v_booking_type_count int := 0;
  v_booking_service_count int := 0;
  v_technician_count int := 0;
  v_primary_technician_id uuid;
  v_existing_primary_technician_id uuid;
  v_booking_max_party_size int := 1;
  v_rows int := 0;
begin
  if length(v_tag) < 4 or length(v_tag) > 40 then
    raise exception 'INVALID_QA_RUN_TAG';
  end if;
  v_created_by := left('qa:e2e:' || lower(v_tag), 120);

  insert into public.ticket_templates(
    ticket_template_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,created_by,updated_by
  ) values
  ('QA-TPL-'||v_tag||'-C1','E2E QA 通用優惠券 '||v_tag,'coupon','跨端 E2E：一般優惠券。','出示後由測試流程核銷。','僅供測試帳號與自動化測試使用。','[]'::jsonb,'active',v_created_by,v_created_by)
  returning id into v_coupon1;
  v_ticket_count := v_ticket_count + 1;

  insert into public.ticket_templates(
    ticket_template_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,created_by,updated_by
  ) values
  ('QA-TPL-'||v_tag||'-C2','E2E QA 高節點優惠券 '||v_tag,'coupon','跨端 E2E：高點數節點優惠券。','達指定節點後核銷。','驗證不同集點節點與多票券映射。','[]'::jsonb,'active',v_created_by,v_created_by)
  returning id into v_coupon2;
  v_ticket_count := v_ticket_count + 1;

  insert into public.ticket_templates(
    ticket_template_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,created_by,updated_by
  ) values
  ('QA-TPL-'||v_tag||'-L1','E2E QA 多獎項抽獎券 '||v_tag,'lottery','跨端 E2E：多獎項抽獎。','開啟後執行抽獎。','驗證機率合計與核銷歷史。',
    jsonb_build_array(
      jsonb_build_object('prizeTitle','A級獎項','prizeDescription','高價值測試獎項','winRate',52.5),
      jsonb_build_object('prizeTitle','B級獎項','prizeDescription','中價值測試獎項','winRate',27.5),
      jsonb_build_object('prizeTitle','C級獎項','prizeDescription','一般測試獎項','winRate',15),
      jsonb_build_object('prizeTitle','安慰獎','prizeDescription','邊界比例測試','winRate',5)
    ),'active',v_created_by,v_created_by)
  returning id into v_lottery1;
  v_ticket_count := v_ticket_count + 1;

  insert into public.ticket_templates(
    ticket_template_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,created_by,updated_by
  ) values
  ('QA-TPL-'||v_tag||'-L2','E2E QA 雙獎項抽獎券 '||v_tag,'lottery','跨端 E2E：第二種抽獎組合。','開啟後執行抽獎。','驗證不同節點映射到不同抽獎券。',
    jsonb_build_array(
      jsonb_build_object('prizeTitle','主要獎項','prizeDescription','主要測試獎項','winRate',73),
      jsonb_build_object('prizeTitle','次要獎項','prizeDescription','次要測試獎項','winRate',27)
    ),'active',v_created_by,v_created_by)
  returning id into v_lottery2;
  v_ticket_count := v_ticket_count + 1;

  insert into public.point_cards(
    card_id,title,description,status,accent,style_key,expiry_mode,expires_on,sort_order,
    usage_method,usage_instructions,benefit_description,created_by,updated_by
  ) values (
    'QA-CARD-'||v_tag||'-MULTI','E2E QA 多節點集點卡 '||v_tag,'四個節點、優惠券與抽獎券混合。','active',
    '#E47845','forest','unlimited',null,9001,
    '管理端發點與真人用戶操作混合。','測試節點 2 / 5 / 13 / 21 點。','跨節點出票、核銷與 Realtime 驗證。',
    v_created_by,v_created_by
  ) returning id into v_card1;
  v_card_count := v_card_count + 1;

  insert into public.point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id)
  values
    ('QA-RWD-'||v_tag||'-02',v_card1,2,v_coupon1),
    ('QA-RWD-'||v_tag||'-05',v_card1,5,v_lottery1),
    ('QA-RWD-'||v_tag||'-13',v_card1,13,v_coupon2),
    ('QA-RWD-'||v_tag||'-21',v_card1,21,v_lottery2);
  get diagnostics v_rows = row_count;
  v_reward_count := v_reward_count + v_rows;

  insert into public.point_cards(
    card_id,title,description,status,accent,style_key,expiry_mode,expires_on,sort_order,
    usage_method,usage_instructions,benefit_description,created_by,updated_by
  ) values (
    'QA-CARD-'||v_tag||'-DATE','E2E QA 日期限制集點卡 '||v_tag,'指定到期日與雙節點。','active',
    '#4C7A73','ocean','date',v_today + 37,9002,
    '測試日期限制集點。','到期日前可正常顯示與累積。','驗證到期日與節點資料同步。',
    v_created_by,v_created_by
  ) returning id into v_card2;
  v_card_count := v_card_count + 1;

  insert into public.point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id)
  values
    ('QA-RWD-'||v_tag||'-D03',v_card2,3,v_coupon1),
    ('QA-RWD-'||v_tag||'-D08',v_card2,8,v_lottery2);
  get diagnostics v_rows = row_count;
  v_reward_count := v_reward_count + v_rows;

  insert into public.point_cards(
    card_id,title,description,status,accent,style_key,expiry_mode,expires_on,sort_order,
    usage_method,usage_instructions,benefit_description,created_by,updated_by
  ) values (
    'QA-CARD-'||v_tag||'-DRAFT','E2E QA 草稿集點卡 '||v_tag,'管理端可見、用戶端不應公開。','draft',
    '#777777','midnight','unlimited',null,9003,
    '草稿資料。','不可對正式會員公開。','驗證公開狀態邊界。',
    v_created_by,v_created_by
  );
  v_card_count := v_card_count + 1;

  insert into public.event_tickets(
    event_ticket_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,
    starts_on,ends_on,quota,accent,allowed_tier_keys,created_by,updated_by
  ) values
  ('QA-EVT-'||v_tag||'-NOW-ALL','E2E QA 進行中全階級活動 '||v_tag,'coupon','目前進行中的全階級活動。','會員領取後核銷。','驗證日期、配額與全階級可見性。','[]'::jsonb,'active',v_today-2,v_today+10,0,'#DF6B4D',array['general','silver','gold','platinum'],v_created_by,v_created_by),
  ('QA-EVT-'||v_tag||'-TODAY-G','E2E QA 當日一般會員活動 '||v_tag,'coupon','僅今天且一般會員可參加。','當日使用。','驗證單日日期邊界與會員階級。','[]'::jsonb,'active',v_today,v_today,7,'#3D7A69',array['general'],v_created_by,v_created_by),
  ('QA-EVT-'||v_tag||'-LOT-VIP','E2E QA VIP 抽獎活動 '||v_tag,'lottery','銀級以上進行中的抽獎活動。','領券後抽獎。','驗證抽獎、多階級與有限配額。',
    jsonb_build_array(
      jsonb_build_object('prizeTitle','VIP A','prizeDescription','VIP 測試獎項','winRate',61),
      jsonb_build_object('prizeTitle','VIP B','prizeDescription','VIP 次獎','winRate',29),
      jsonb_build_object('prizeTitle','VIP C','prizeDescription','VIP 邊界獎','winRate',10)
    ),'active',v_today-1,v_today+4,12,'#6B5B95',array['silver','gold','platinum'],v_created_by,v_created_by),
  ('QA-EVT-'||v_tag||'-FUTURE','E2E QA 未來白金活動 '||v_tag,'coupon','尚未開始的高階會員活動。','活動開始後使用。','驗證未來日期與高階會員限制。','[]'::jsonb,'active',v_today+7,v_today+21,30,'#8A6D3B',array['gold','platinum'],v_created_by,v_created_by),
  ('QA-EVT-'||v_tag||'-PAST','E2E QA 已過期活動 '||v_tag,'coupon','已結束但仍保留狀態資料。','不可再領取。','驗證過期日期邊界。','[]'::jsonb,'active',v_today-21,v_today-1,5,'#555555',array['general','silver','gold','platinum'],v_created_by,v_created_by),
  ('QA-EVT-'||v_tag||'-DRAFT','E2E QA 草稿抽獎活動 '||v_tag,'lottery','草稿狀態活動。','不可公開。','驗證草稿不可由用戶端領取。',
    jsonb_build_array(
      jsonb_build_object('prizeTitle','草稿 A','prizeDescription','草稿測試','winRate',50),
      jsonb_build_object('prizeTitle','草稿 B','prizeDescription','草稿測試','winRate',50)
    ),'draft',v_today+1,v_today+30,100,'#999999',array['general','silver','gold','platinum'],v_created_by,v_created_by);
  get diagnostics v_event_count = row_count;

  insert into public.calendar_items(
    calendar_item_id,title,item_type,description,starts_on,ends_on,status,accent,allowed_tier_keys,
    link_label,link_url,created_by,updated_by,bonus_points_enabled,bonus_points,audience_type,audience_month
  ) values
  ('QA-CAL-'||v_tag||'-HOL','E2E QA 今日公休日 '||v_tag,'holiday','驗證公休日與預約衝突。',v_today,v_today,'active','#B64E4E',array[]::text[],'','',v_created_by,v_created_by,false,0,'all',null),
  ('QA-CAL-'||v_tag||'-GEN','E2E QA 一般銀級活動 '||v_tag,'event','一般與銀級會員活動。',v_today,v_today+1,'active','#367C72',array['general','silver'],'查看測試活動','https://example.com/qa-event',v_created_by,v_created_by,true,3,'all',null),
  ('QA-CAL-'||v_tag||'-VIP','E2E QA 金白金多日活動 '||v_tag,'event','金級與白金會員的多日活動。',v_today+2,v_today+5,'active','#7A5E9A',array['gold','platinum'],'活動詳情','https://example.com/qa-vip',v_created_by,v_created_by,true,8,'all',null),
  ('QA-CAL-'||v_tag||'-FUT','E2E QA 未來全階級活動 '||v_tag,'event','未來日期活動。',v_today+14,v_today+18,'active','#C57B38',array['general','silver','gold','platinum'],'未來活動','https://example.com/qa-future',v_created_by,v_created_by,false,0,'all',null),
  ('QA-CAL-'||v_tag||'-ARC','E2E QA 已封存活動 '||v_tag,'event','歷史封存活動。',v_today-30,v_today-28,'archived','#777777',array['general','silver','gold','platinum'],'','',v_created_by,v_created_by,false,0,'all',null);
  get diagnostics v_calendar_count = row_count;

  insert into public.fixed_ticket_templates(
    fixed_ticket_id,title,description,usage_method,usage_instructions,status,schedule_type,schedule_month,schedule_day,schedule_weekday,
    quota,accent,allowed_tier_keys,notify_line,created_by,updated_by,expiry_mode,expiry_date,expiry_days,calendar_enabled
  ) values
  ('QA-FIX-'||v_tag||'-BDAY','E2E QA 生日月固定票券 '||v_tag,'生日月固定發放。','系統自動發放。','測試帳號不傳 LINE。','active','birthday_month',null,null,null,0,'#E47845',array['general','silver','gold','platinum'],false,v_created_by,v_created_by,'month_end',null,null,true),
  ('QA-FIX-'||v_tag||'-YEAR','E2E QA 每年高階固定票券 '||v_tag,'每年固定日期發放。','系統自動發放。','金級與白金會員測試。','active','yearly',extract(month from v_today)::int,least(extract(day from v_today)::int,28),null,50,'#8A6D3B',array['gold','platinum'],false,v_created_by,v_created_by,'fixed_date',v_today+90,null,true),
  ('QA-FIX-'||v_tag||'-MONTH','E2E QA 每月限期固定票券 '||v_tag,'每月固定日發放。','系統自動發放。','一般與銀級會員測試。','active','monthly',null,least(extract(day from v_today)::int,28),null,100,'#3D7A69',array['general','silver'],false,v_created_by,v_created_by,'days_after_issue',null,14,false),
  ('QA-FIX-'||v_tag||'-WEEK','E2E QA 每週固定票券 '||v_tag,'每週固定日發放。','系統自動發放。','驗證當週到期模式。','active','weekly',null,null,extract(isodow from v_today)::int,0,'#6B5B95',array['general','silver','gold','platinum'],false,v_created_by,v_created_by,'week_end',null,null,false);
  get diagnostics v_fixed_count = row_count;

  insert into public.booking_service_types(name,sort_order)
  values
    ('E2E QA 基礎服務 '||v_tag,901),
    ('E2E QA 加購服務 '||v_tag,902),
    ('E2E QA 長時數服務 '||v_tag,903);
  v_booking_type_count := 3;

  select id into v_type1 from public.booking_service_types where name='E2E QA 基礎服務 '||v_tag order by created_at desc limit 1;
  select id into v_type2 from public.booking_service_types where name='E2E QA 加購服務 '||v_tag order by created_at desc limit 1;
  select id into v_type3 from public.booking_service_types where name='E2E QA 長時數服務 '||v_tag order by created_at desc limit 1;

  insert into public.booking_service_type_rewards(service_type_id,point_card_id,minutes_per_point,created_by,updated_by)
  values
    (v_type1,v_card1,30,v_created_by,v_created_by),
    (v_type3,v_card2,75,v_created_by,v_created_by);

  insert into public.booking_services(
    title,description,is_active,
    created_by,duration_minutes,price_amount,service_type,counts_toward_membership,requires_companion_service
  ) values
  ('E2E QA 標準主服務 '||v_tag,'30 分鐘計入會員階級。',true,v_created_by,30,880,'E2E QA 基礎服務 '||v_tag,true,false),
  ('E2E QA 加購短服務 '||v_tag,'必須搭配其他項目，不計會員階級。',true,v_created_by,15,260,'E2E QA 加購服務 '||v_tag,false,true),
  ('E2E QA 長時數主服務 '||v_tag,'跨多時段、計入會員階級。',true,v_created_by,120,2480,'E2E QA 長時數服務 '||v_tag,true,false),
  ('E2E QA 停用服務 '||v_tag,'管理端保留但用戶端不可預約。',false,v_created_by,45,999,'E2E QA 基礎服務 '||v_tag,true,false);
  get diagnostics v_booking_service_count = row_count;

  insert into public.booking_technicians(name,is_active,sort_order,created_by)
  values
    ('E2E QA 技師甲 '||v_tag,true,901,v_created_by),
    ('E2E QA 技師乙 '||v_tag,true,902,v_created_by),
    ('E2E QA 停用技師 '||v_tag,false,903,v_created_by);
  get diagnostics v_technician_count = row_count;

  select id into v_primary_technician_id
    from public.booking_technicians
   where name = 'E2E QA 技師甲 '||v_tag
     and is_active = true
   order by created_at desc
   limit 1;

  -- A paired E2E fixture must be self-contained. Always bind the current
  -- fixture's active technician as primary instead of silently reusing a
  -- technician created by an earlier retained QA run.
  select primary_technician_id
    into v_existing_primary_technician_id
    from public.booking_settings
   where id = 1;

  if not found then
    insert into public.booking_settings(id,max_party_size,primary_technician_id,updated_by)
    values (1,2,v_primary_technician_id,v_created_by);
  else
    update public.booking_settings
       set primary_technician_id = v_primary_technician_id,
           max_party_size = greatest(max_party_size,2),
           updated_by = v_created_by,
           updated_at = clock_timestamp()
     where id = 1;
  end if;

  select max_party_size into v_booking_max_party_size
    from public.booking_settings
   where id = 1;

  return jsonb_build_object(
    'runTag', v_tag,
    'createdBy', v_created_by,
    'today', v_today,
    'ticketTemplates', v_ticket_count,
    'pointCards', v_card_count,
    'pointRewardNodes', v_reward_count,
    'eventTickets', v_event_count,
    'calendarItems', v_calendar_count,
    'fixedTickets', v_fixed_count,
    'bookingServiceTypes', v_booking_type_count,
    'bookingServices', v_booking_service_count,
    'bookingTechnicians', v_technician_count,
    'primaryTechnicianId', coalesce((select primary_technician_id::text from public.booking_settings where id=1),''),
    'maxPartySize', v_booking_max_party_size,
    'coverage', jsonb_build_object(
      'ticketTypes', jsonb_build_array('coupon','lottery','fixed'),
      'fixedSchedules', jsonb_build_array('birthday_month','yearly','monthly','weekly'),
      'fixedExpiryModes', jsonb_build_array('month_end','week_end','days_after_issue','fixed_date'),
      'eventDateStates', jsonb_build_array('past','today','active-window','future'),
      'membershipTiers', jsonb_build_array('general','silver','gold','platinum'),
      'pointThresholds', jsonb_build_array(2,3,5,8,13,21),
      'bookingModes', jsonb_build_array('primary','companion','membership-counting','non-membership','inactive')
    )
  );
end
$function$
;
CREATE OR REPLACE FUNCTION maintenance.ensure_required_system_baseline()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_primary_technician_id uuid;
begin
  -- Booking service categories must exist before the built-in service is usable
  -- in admin/user booking selectors after a full reset.
  insert into public.booking_service_types(name, sort_order)
  values ('店內招待', 0)
  on conflict do nothing;

  -- A booking cannot be created unless booking_settings points to an active
  -- primary technician. Recreate a deterministic system baseline technician
  -- after one-click clear, while preserving any valid admin-selected primary.
  insert into public.booking_technicians(
    name,
    is_active,
    sort_order,
    created_by
  )
  values ('系統主要技師', true, 0, 'system')
  on conflict do nothing;

  update public.booking_technicians
     set is_active = true,
         sort_order = 0,
         updated_at = clock_timestamp()
   where lower(btrim(name)) = lower(btrim('系統主要技師'));

  select id
    into v_primary_technician_id
    from public.booking_technicians
   where lower(btrim(name)) = lower(btrim('系統主要技師'))
     and is_active = true
   order by created_at
   limit 1;

  if v_primary_technician_id is null then
    raise exception 'SYSTEM_PRIMARY_TECHNICIAN_BASELINE_FAILED';
  end if;

  insert into public.booking_settings(
    id,
    work_start_time,
    work_end_time,
    min_advance_days,
    max_advance_days,
    booking_notice,
    max_party_size,
    primary_technician_id,
    updated_by
  )
  values (
    1,
    '09:00:00',
    '17:00:00',
    0,
    0,
    '',
    1,
    v_primary_technician_id,
    'system'
  )
  on conflict (id) do nothing;

  -- Do not overwrite a valid administrator-selected primary technician.
  -- Repair only a missing or inactive reference.
  update public.booking_settings bs
     set primary_technician_id = v_primary_technician_id,
         updated_by = 'system-baseline',
         updated_at = clock_timestamp()
   where bs.id = 1
     and (
       bs.primary_technician_id is null
       or not exists (
         select 1
           from public.booking_technicians t
          where t.id = bs.primary_technician_id
            and t.is_active = true
       )
     );

  insert into public.membership_tier_settings(
    tier_key,
    tier_label,
    required_service_minutes,
    style_key,
    updated_by
  )
  values
    ('general', '一般會員', 0, 'forest', 'system'),
    ('silver', '銀級會員', 600, 'ocean', 'system'),
    ('gold', '金級會員', 1800, 'gold', 'system'),
    ('platinum', '白金會員', 3600, 'platinum', 'system')
  on conflict (tier_key) do nothing;

  insert into public.point_card_settings(
    id,
    max_tickets_per_redemption,
    updated_by
  )
  values (1, 1, 'system')
  on conflict (id) do nothing;

  insert into public.booking_services(
    id,
    title,
    description,
    service_type,
    duration_minutes,
    price_amount,
    counts_toward_membership,
    is_active,
    requires_companion_service,
    created_by
  )
  values (
    '00000000-0000-4000-8000-000000000010'::uuid,
    '店內服務（肩頸／龜苓膏／熱茶）',
    '__SYSTEM__:included-store-service',
    '店內招待',
    10,
    0,
    false,
    true,
    false,
    'system'
  )
  on conflict (id) do nothing;

  insert into public.test_mode_settings(
    id,
    maintenance_message,
    updated_by,
    maintenance_enabled,
    allow_pc_test_login,
    allow_mobile_test_login
  )
  values (true, '', 'system', false, false, false)
  on conflict (id) do nothing;

  insert into booking_notifications.config(id, enabled)
  values (true, true)
  on conflict (id) do update
    set enabled = excluded.enabled;

  -- Postconditions: a one-click clear must be atomic. If any required baseline
  -- cannot be rebuilt, raise so the surrounding TRUNCATE transaction rolls back
  -- instead of leaving a partially-cleared, unusable system.
  if not exists (
    select 1
      from public.booking_settings bs
      join public.booking_technicians t
        on t.id = bs.primary_technician_id
       and t.is_active = true
     where bs.id = 1
  ) then
    raise exception 'REQUIRED_BOOKING_BASELINE_INVALID';
  end if;

  if not exists (
    select 1
      from public.booking_service_types
     where lower(btrim(name)) = lower(btrim('店內招待'))
  ) then
    raise exception 'REQUIRED_BOOKING_SERVICE_TYPE_BASELINE_INVALID';
  end if;

  if not exists (
    select 1
      from public.booking_services
     where id = '00000000-0000-4000-8000-000000000010'::uuid
       and is_active = true
       and lower(btrim(coalesce(service_type, ''))) = lower(btrim('店內招待'))
  ) then
    raise exception 'REQUIRED_BOOKING_SERVICE_BASELINE_INVALID';
  end if;

  if (select count(*) from public.membership_tier_settings
      where tier_key in ('general','silver','gold','platinum')) < 4 then
    raise exception 'REQUIRED_MEMBERSHIP_TIER_BASELINE_INVALID';
  end if;

  if not exists (select 1 from public.point_card_settings where id = 1)
     or not exists (select 1 from public.test_mode_settings where id = true)
     or not exists (select 1 from booking_notifications.config where id = true) then
    raise exception 'REQUIRED_SYSTEM_SETTINGS_BASELINE_INVALID';
  end if;
end;
$function$
;
CREATE OR REPLACE FUNCTION maintenance.ensure_event_ticket_settings_baseline()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  insert into public.event_ticket_settings(
    id,
    max_tickets_per_day,
    updated_by
  )
  values (1, 1, 'system')
  on conflict (id) do nothing;

  if not exists (
    select 1
      from public.event_ticket_settings
     where id = 1
       and max_tickets_per_day between 0 and 50
  ) then
    raise exception 'REQUIRED_EVENT_TICKET_SETTINGS_BASELINE_INVALID';
  end if;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.count_today_usable_event_tickets(p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_member public.members%rowtype;
  v_tier text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_day_start timestamptz := (v_today::timestamp at time zone 'Asia/Taipei');
  v_day_end timestamptz := ((v_today + 1)::timestamp at time zone 'Asia/Taipei');
  v_available_count integer := 0;
  v_used_today_count integer := 0;
  v_max_tickets integer := 1;
  v_remaining_today integer := 0;
begin
  select * into v_member
  from public.members
  where line_user_id=p_line_user_id
    and status='active'
    and membership_status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  v_tier:=public.current_tier_key(v_member.id);

  select coalesce(max_tickets_per_day, 1)
    into v_max_tickets
  from public.event_ticket_settings
  where id=1;
  v_max_tickets := coalesce(v_max_tickets,1);

  select count(*)::integer into v_used_today_count
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.status='used'
    and c.used_at >= v_day_start
    and c.used_at < v_day_end;

  select count(*)::integer into v_available_count
  from public.event_ticket_claims c
  join public.event_tickets e on e.id=c.event_ticket_id
  where c.member_id=v_member.id
    and c.status='claimed'
    and e.deleted_at is null
    and e.status='active'
    and (e.starts_on is null or e.starts_on<=v_today)
    and (e.ends_on is null or e.ends_on>=v_today)
    and v_tier=any(e.allowed_tier_keys);

  if v_max_tickets = 0 then
    v_remaining_today := v_available_count;
  else
    v_remaining_today := greatest(v_max_tickets - v_used_today_count, 0);
  end if;

  return jsonb_build_object(
    'businessDate',v_today,
    'availableTodayCount',v_available_count,
    'usedTodayCount',v_used_today_count,
    'remainingTodayCount',v_remaining_today,
    'maxTicketsPerDay',v_max_tickets,
    'maxTicketsPerRedemption',v_max_tickets,
    'todayUsableCount',least(v_available_count,v_remaining_today)
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.redeem_event_ticket(p_line_user_id text, p_claim_id text, p_location jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_member public.members%rowtype;
  v_claim public.event_ticket_claims%rowtype;
  v_event public.event_tickets%rowtype;
  v_tier text;
  v_result jsonb := null;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_day_start timestamptz := (v_today::timestamp at time zone 'Asia/Taipei');
  v_day_end timestamptz := ((v_today + 1)::timestamp at time zone 'Asia/Taipei');
  v_max_tickets integer := 1;
  v_used_today_count integer := 0;
begin
  select * into v_member
  from public.members
  where line_user_id=p_line_user_id
    and membership_status='active'
    and status='active'
  for update;
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select * into v_claim
  from public.event_ticket_claims
  where claim_id=p_claim_id
    and member_id=v_member.id
  for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.status='used' then
    return jsonb_build_object('claimId',v_claim.claim_id,'alreadyUsed',true);
  end if;
  if v_claim.status <> 'claimed' then raise exception 'CLAIM_NOT_AVAILABLE'; end if;

  select coalesce(max_tickets_per_day, 1)
    into v_max_tickets
  from public.event_ticket_settings
  where id=1;
  v_max_tickets := coalesce(v_max_tickets,1);

  select count(*)::integer into v_used_today_count
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.status='used'
    and c.used_at >= v_day_start
    and c.used_at < v_day_end;

  if v_max_tickets > 0 and v_used_today_count >= v_max_tickets then
    raise exception 'EVENT_TICKET_DAILY_LIMIT_REACHED';
  end if;

  select * into v_event
  from public.event_tickets
  where id=v_claim.event_ticket_id
    and deleted_at is null
  for update;
  if not found or v_event.status <> 'active' then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'EVENT_NOT_STARTED'; end if;
  if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'EVENT_ENDED'; end if;

  v_tier := public.current_tier_key(v_member.id);
  if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;
  if v_event.requires_location then
    perform public.verify_ticket_redemption_locations(v_event.redemption_locations,p_location);
  end if;

  if v_claim.ticket_type='lottery' then
    v_result := public.pick_lottery_prize(v_claim.prizes);
  end if;

  update public.event_ticket_claims
  set status='used',
      used_at=now(),
      result=v_result,
      updated_at=now()
  where id=v_claim.id
    and status='claimed';
  if not found then raise exception 'CLAIM_NOT_AVAILABLE'; end if;

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values (
    public.new_public_id('AUD'),
    v_member.line_user_id,
    'member',
    'user.event.ticket.redeem',
    'event_claim',
    v_claim.claim_id,
    'success',
    jsonb_build_object(
      'businessDate',v_today,
      'usedTodayCount',v_used_today_count + 1,
      'maxTicketsPerDay',v_max_tickets
    )
  );

  return jsonb_build_object(
    'claimId',v_claim.claim_id,
    'alreadyUsed',false,
    'businessDate',v_today,
    'usedTodayCount',v_used_today_count + 1,
    'maxTicketsPerDay',v_max_tickets,
    'remainingTodayCount',case when v_max_tickets = 0 then null else greatest(v_max_tickets - (v_used_today_count + 1),0) end
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.redeem_event_tickets_with_location(p_line_user_id text, p_claim_ids text[], p_request_id text, p_location jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_member public.members%rowtype;
  v_claim public.event_ticket_claims%rowtype;
  v_event public.event_tickets%rowtype;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_day_start timestamptz := (v_today::timestamp at time zone 'Asia/Taipei');
  v_day_end timestamptz := ((v_today + 1)::timestamp at time zone 'Asia/Taipei');
  v_tier text;
  v_max_tickets integer := 1;
  v_used_today_count integer := 0;
  v_selected_count integer := 0;
  v_processed integer := 0;
  v_result jsonb := null;
  v_results jsonb := '[]'::jsonb;
  v_existing jsonb;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then
    raise exception 'INVALID_REQUEST_ID';
  end if;
  if p_claim_ids is null or cardinality(p_claim_ids) < 1 or cardinality(p_claim_ids) > 50 then
    raise exception 'INVALID_EVENT_TICKET_BATCH';
  end if;
  if exists(
    select 1 from unnest(p_claim_ids) as selected(claim_id)
    where nullif(btrim(selected.claim_id),'') is null
  ) then
    raise exception 'INVALID_EVENT_TICKET_BATCH';
  end if;
  if (select count(distinct selected.claim_id) from unnest(p_claim_ids) as selected(claim_id)) <> cardinality(p_claim_ids) then
    raise exception 'INVALID_EVENT_TICKET_BATCH';
  end if;

  select * into v_member
  from public.members
  where line_user_id=p_line_user_id
    and membership_status='active'
    and status='active'
  for update;
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select detail into v_existing
  from public.audit_logs
  where actor_line_user_id=v_member.line_user_id
    and action='user.event.tickets.redeem'
    and target_type='event_claim_batch'
    and target_id=p_request_id
    and result='success'
  order by created_at desc
  limit 1;
  if found then
    return coalesce(v_existing,'{}'::jsonb)
      || jsonb_build_object('requestId',p_request_id,'alreadyApplied',true);
  end if;

  select coalesce(max_tickets_per_day, 1)
    into v_max_tickets
  from public.event_ticket_settings
  where id=1;
  v_max_tickets := coalesce(v_max_tickets,1);

  select count(*)::integer into v_used_today_count
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.status='used'
    and c.used_at >= v_day_start
    and c.used_at < v_day_end;

  if v_max_tickets > 0 and v_used_today_count + cardinality(p_claim_ids) > v_max_tickets then
    raise exception 'EVENT_TICKET_DAILY_LIMIT_REACHED';
  end if;

  perform 1
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.claim_id=any(p_claim_ids)
  order by c.claim_id
  for update;

  select count(*)::integer into v_selected_count
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.claim_id=any(p_claim_ids);
  if v_selected_count <> cardinality(p_claim_ids) then
    raise exception 'CLAIM_NOT_FOUND';
  end if;

  if exists(
    select 1
    from public.event_ticket_claims c
    where c.member_id=v_member.id
      and c.claim_id=any(p_claim_ids)
      and c.status <> 'claimed'
  ) then
    raise exception 'CLAIM_NOT_AVAILABLE';
  end if;

  perform 1
  from public.event_tickets e
  where e.id in (
    select c.event_ticket_id
    from public.event_ticket_claims c
    where c.member_id=v_member.id
      and c.claim_id=any(p_claim_ids)
  )
  order by e.id
  for update;

  v_tier := public.current_tier_key(v_member.id);

  for v_claim in
    select c.*
    from public.event_ticket_claims c
    where c.member_id=v_member.id
      and c.claim_id=any(p_claim_ids)
    order by c.claim_id
  loop
    select * into v_event
    from public.event_tickets
    where id=v_claim.event_ticket_id
      and deleted_at is null;

    if not found or v_event.status <> 'active' then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
    if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'EVENT_NOT_STARTED'; end if;
    if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'EVENT_ENDED'; end if;
    if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;
    if v_event.requires_location then
      perform public.verify_ticket_redemption_locations(v_event.redemption_locations,p_location);
    end if;

    v_result := null;
    if v_claim.ticket_type='lottery' then
      v_result := public.pick_lottery_prize(v_claim.prizes);
    end if;

    update public.event_ticket_claims
    set status='used',
        used_at=now(),
        result=v_result,
        updated_at=now()
    where id=v_claim.id
      and status='claimed';
    if not found then raise exception 'CLAIM_NOT_AVAILABLE'; end if;

    v_processed := v_processed + 1;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'claimId',v_claim.claim_id,
      'eventTicketId',v_event.event_ticket_id,
      'ticketTitle',v_claim.ticket_title,
      'ticketType',v_claim.ticket_type,
      'result',v_result
    ));
  end loop;

  v_existing := jsonb_build_object(
    'requestId',p_request_id,
    'claimIds',to_jsonb(p_claim_ids),
    'ticketCount',v_processed,
    'maxTicketsPerDay',v_max_tickets,
    'businessDate',v_today,
    'usedTodayCount',v_used_today_count + v_processed,
    'remainingTodayCount',case when v_max_tickets = 0 then null else greatest(v_max_tickets - (v_used_today_count + v_processed),0) end,
    'tickets',v_results,
    'alreadyApplied',false
  );

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values (
    public.new_public_id('AUD'),
    v_member.line_user_id,
    'member',
    'user.event.tickets.redeem',
    'event_claim_batch',
    p_request_id,
    'success',
    v_existing
  );

  return v_existing;
end;
$function$
;
notify pgrst, 'reload schema';
