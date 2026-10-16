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
  v_template public.fixed_ticket_templates%rowtype;
  v_event public.event_tickets%rowtype;
  v_referral_id text;
  v_cycle_key text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_expires date;
  v_claim_id text;
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

  if coalesce(v_invitee.joined_at, v_invitee.created_at) < now() - interval '24 hours' then
    raise exception 'REFERRAL_WINDOW_CLOSED';
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

  select * into v_template
  from public.fixed_ticket_templates
  where fixed_ticket_id = 'REFERRAL-REWARD'
    and deleted_at is null
  for share;

  if not found then
    raise exception 'REFERRAL_REWARD_TEMPLATE_MISSING';
  end if;

  v_referral_id := public.new_public_id('RF');
  v_cycle_key := 'referral:' || v_referral_id;
  v_expires := v_today + greatest(coalesce(v_template.expiry_days, 30), 1) - 1;

  insert into public.event_tickets(
    event_ticket_id,title,ticket_type,description,usage_method,usage_instructions,prizes,status,
    starts_on,ends_on,quota,accent,allowed_tier_keys,created_by,updated_by,
    activity_url,activity_link_name,fixed_ticket_template_id,fixed_cycle_key,
    requires_location,redemption_locations
  ) values (
    'REFERRAL-' || v_referral_id,
    v_template.title,
    'coupon',
    v_template.description,
    v_template.usage_method,
    v_template.usage_instructions,
    '[]'::jsonb,
    'active',
    v_today,
    v_expires,
    2,
    lower(v_template.accent),
    v_template.allowed_tier_keys,
    'member-referral',
    'member-referral',
    '',
    '',
    v_template.id,
    v_cycle_key,
    false,
    '[]'::jsonb
  )
  returning * into v_event;

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
    v_claim_id,v_event.id,v_inviter.id,'coupon',v_event.title,v_event.description,
    v_event.usage_method,v_event.usage_instructions,'[]'::jsonb,'claimed',now()
  );
  insert into public.fixed_ticket_grants(
    fixed_ticket_template_id,member_id,cycle_key,cycle_start,cycle_end,event_ticket_id,claim_id,status
  ) values (
    v_template.id,v_inviter.id,v_cycle_key,v_today,v_expires,v_event.id,v_claim_id,'issued'
  );

  v_claim_id := public.new_public_id('EC');
  insert into public.event_ticket_claims(
    claim_id,event_ticket_id,member_id,ticket_type,ticket_title,ticket_description,
    usage_method,usage_instructions,prizes,status,claimed_at
  ) values (
    v_claim_id,v_event.id,v_invitee.id,'coupon',v_event.title,v_event.description,
    v_event.usage_method,v_event.usage_instructions,'[]'::jsonb,'claimed',now()
  );
  insert into public.fixed_ticket_grants(
    fixed_ticket_template_id,member_id,cycle_key,cycle_start,cycle_end,event_ticket_id,claim_id,status
  ) values (
    v_template.id,v_invitee.id,v_cycle_key,v_today,v_expires,v_event.id,v_claim_id,'issued'
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
      'trigger','membership_activation',
      'rewardEventTicketId',v_event.event_ticket_id,
      'rewardExpiresOn',v_expires,
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
    'rewardExpiresOn', v_expires,
    'inviterMemberCode', v_inviter.member_code
  );
end;
$$;

revoke all on function public.bind_member_referral(text,text,text) from public,anon,authenticated;
grant execute on function public.bind_member_referral(text,text,text) to service_role;
