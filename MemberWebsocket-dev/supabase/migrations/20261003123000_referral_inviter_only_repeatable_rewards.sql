begin;

alter table public.event_tickets
  add column if not exists referral_source_event_ticket_id uuid
  references public.event_tickets(id) on delete restrict;

alter table public.event_tickets
  drop constraint if exists event_tickets_referral_source_valid;
alter table public.event_tickets
  add constraint event_tickets_referral_source_valid
  check (
    referral_source_event_ticket_id is null
    or (
      ticket_type = 'referral'
      and referral_source_event_ticket_id <> id
    )
  );

create index if not exists event_tickets_referral_source_idx
  on public.event_tickets(referral_source_event_ticket_id)
  where referral_source_event_ticket_id is not null;

drop index if exists public.event_tickets_one_active_referral_idx;
create unique index event_tickets_one_active_referral_idx
  on public.event_tickets (ticket_type)
  where ticket_type = 'referral'
    and status = 'active'
    and deleted_at is null
    and referral_source_event_ticket_id is null;

create or replace function public.bind_member_referral(
  p_invitee_line_user_id text,
  p_invite_code text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
    required_service_types,
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
    coalesce(v_source_event.required_service_types, '{}'::text[]),
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
$$;

revoke all on function public.bind_member_referral(text,text,text) from public, anon, authenticated;
grant execute on function public.bind_member_referral(text,text,text) to service_role;

commit;
