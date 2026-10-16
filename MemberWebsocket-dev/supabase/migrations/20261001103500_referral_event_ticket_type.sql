begin;

alter table public.event_tickets
  drop constraint if exists event_tickets_ticket_type_check;
alter table public.event_tickets
  add constraint event_tickets_ticket_type_check
  check (ticket_type = any (array['coupon'::text, 'lottery'::text, 'referral'::text]));

alter table public.event_ticket_claims
  drop constraint if exists event_ticket_claims_ticket_type_check;
alter table public.event_ticket_claims
  add constraint event_ticket_claims_ticket_type_check
  check (ticket_type = any (array['coupon'::text, 'lottery'::text, 'referral'::text]));

create unique index if not exists event_tickets_one_active_referral_idx
  on public.event_tickets (ticket_type)
  where ticket_type = 'referral'
    and status = 'active'
    and deleted_at is null;

create or replace function public.claim_event_ticket(
  p_line_user_id text,
  p_event_ticket_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.members%rowtype;
  v_event public.event_tickets%rowtype;
  v_tier text;
  v_claim_id text;
  v_today date;
  v_count integer;
begin
  select * into v_member from public.members
    where line_user_id=p_line_user_id and membership_status='active' and status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select * into v_event from public.event_tickets
    where event_ticket_id=p_event_ticket_id for update;
  if not found then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  if v_event.fixed_ticket_template_id is not null then raise exception 'FIXED_TICKET_AUTO_ONLY'; end if;
  if v_event.ticket_type = 'referral' then raise exception 'REFERRAL_TICKET_AUTO_ONLY'; end if;

  select claim_id into v_claim_id from public.event_ticket_claims
    where event_ticket_id=v_event.id and member_id=v_member.id;
  if found then return jsonb_build_object('claimId',v_claim_id,'alreadyClaimed',true); end if;

  if v_event.deleted_at is not null or v_event.status <> 'active' then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  v_today := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'EVENT_NOT_STARTED'; end if;
  if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'EVENT_ENDED'; end if;

  v_tier := public.current_tier_key(v_member.id);
  if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;

  if v_event.quota > 0 then
    select count(*)::integer into v_count from public.event_ticket_claims where event_ticket_id=v_event.id;
    if v_count >= v_event.quota then raise exception 'EVENT_QUOTA_REACHED'; end if;
  end if;

  v_claim_id := public.new_public_id('EC');
  insert into public.event_ticket_claims(
    claim_id,event_ticket_id,member_id,ticket_type,ticket_title,ticket_description,usage_method,usage_instructions,prizes
  ) values (
    v_claim_id,v_event.id,v_member.id,v_event.ticket_type,v_event.title,v_event.description,v_event.usage_method,v_event.usage_instructions,v_event.prizes
  );

  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result)
    values(public.new_public_id('AUD'),v_member.line_user_id,'member','user.event.ticket.claim','event_ticket',v_event.event_ticket_id,'success');

  return jsonb_build_object('claimId',v_claim_id,'alreadyClaimed',false);
end;
$$;

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
  v_event public.event_tickets%rowtype;
  v_referral_id text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_claim_id text;
  v_claim_count integer := 0;
  v_inviter_tier text;
  v_invitee_tier text;
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
    select * into v_inviter from public.members where id = v_existing.inviter_member_id;
    if v_existing.invite_code <> p_invite_code then
      raise exception 'REFERRAL_ALREADY_BOUND';
    end if;
    return jsonb_build_object(
      'referralId', v_existing.referral_id,
      'alreadyApplied', true,
      'rewardStatus', v_existing.reward_status,
      'rewardEventTicketId', (
        select e.event_ticket_id from public.event_tickets e where e.id = v_existing.reward_event_ticket_id
      ),
      'rewardExpiresOn', (
        select e.ends_on from public.event_tickets e where e.id = v_existing.reward_event_ticket_id
      ),
      'inviterMemberCode', v_inviter.member_code
    );
  end if;

  select * into v_inviter
  from public.members
  where invite_code = p_invite_code
    and status = 'active'
    and membership_status = 'active';

  if not found then raise exception 'INVITE_CODE_NOT_FOUND'; end if;
  if v_inviter.id = v_invitee.id then raise exception 'SELF_REFERRAL_NOT_ALLOWED'; end if;

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

  select * into v_event
  from public.event_tickets
  where ticket_type = 'referral'
    and status = 'active'
    and deleted_at is null
    and (starts_on is null or starts_on <= v_today)
    and (ends_on is null or ends_on >= v_today)
  order by created_at desc
  limit 1
  for update;

  if not found then raise exception 'REFERRAL_REWARD_UNAVAILABLE'; end if;

  v_inviter_tier := public.current_tier_key(v_inviter.id);
  v_invitee_tier := public.current_tier_key(v_invitee.id);
  if not (v_inviter_tier = any(v_event.allowed_tier_keys))
     or not (v_invitee_tier = any(v_event.allowed_tier_keys)) then
    raise exception 'REFERRAL_REWARD_NOT_ELIGIBLE';
  end if;

  if v_event.quota > 0 then
    select count(*)::integer into v_claim_count
    from public.event_ticket_claims
    where event_ticket_id = v_event.id;
    if v_claim_count + 2 > v_event.quota then
      raise exception 'REFERRAL_REWARD_SOLD_OUT';
    end if;
  end if;

  v_referral_id := public.new_public_id('RF');

  insert into public.member_referrals(
    referral_id, inviter_member_id, invitee_member_id, invite_code, request_id,
    trigger_type, reward_status, reward_event_ticket_id, rewarded_at
  ) values (
    v_referral_id, v_inviter.id, v_invitee.id, p_invite_code, p_request_id,
    'membership_activation', 'issued', v_event.id, now()
  );

  v_claim_id := public.new_public_id('EC');
  insert into public.event_ticket_claims(
    claim_id,event_ticket_id,member_id,ticket_type,ticket_title,ticket_description,
    usage_method,usage_instructions,prizes,status,claimed_at
  ) values (
    v_claim_id,v_event.id,v_inviter.id,'referral',v_event.title,v_event.description,
    v_event.usage_method,v_event.usage_instructions,'[]'::jsonb,'claimed',now()
  );

  v_claim_id := public.new_public_id('EC');
  insert into public.event_ticket_claims(
    claim_id,event_ticket_id,member_id,ticket_type,ticket_title,ticket_description,
    usage_method,usage_instructions,prizes,status,claimed_at
  ) values (
    v_claim_id,v_event.id,v_invitee.id,'referral',v_event.title,v_event.description,
    v_event.usage_method,v_event.usage_instructions,'[]'::jsonb,'claimed',now()
  );

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values (
    public.new_public_id('AUD'),
    v_invitee.line_user_id,
    'member',
    'user.member.referral.bind',
    'member_referral',
    v_referral_id,
    'success',
    jsonb_build_object(
      'inviterMemberId',v_inviter.id,
      'inviteeMemberId',v_invitee.id,
      'trigger','invite_code_bind',
      'rewardEventTicketId',v_event.event_ticket_id,
      'rewardExpiresOn',v_event.ends_on,
      'rewardCount',2
    )
  );

  insert into public.realtime_events(scope,event_type)
  values ('event','member.referral.reward-issued');

  return jsonb_build_object(
    'referralId', v_referral_id,
    'alreadyApplied', false,
    'rewardStatus', 'issued',
    'rewardEventTicketId', v_event.event_ticket_id,
    'rewardExpiresOn', v_event.ends_on,
    'inviterMemberCode', v_inviter.member_code
  );
end;
$$;

revoke all on function public.bind_member_referral(text,text,text) from public, anon, authenticated;
grant execute on function public.bind_member_referral(text,text,text) to service_role;

commit;
