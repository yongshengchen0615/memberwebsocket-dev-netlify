-- A campaign's quota limits completed redemptions, never issued entitlements.
-- Existing tickets remain owned; all redemption pathways are guarded at the
-- event_ticket_claims status transition in PostgreSQL.
-- Quota 0 is unlimited. Referral reward child tickets share the parent quota.

create or replace function public.issue_eligible_general_event_ticket(p_event_id uuid)
returns integer language plpgsql security definer set search_path = ''
as $body$
declare
  v_event public.event_tickets%rowtype;
  v_issued integer := 0;
begin
  select * into v_event from public.event_tickets
    where id=p_event_id for update;
  if not found or v_event.status <> 'active' or v_event.deleted_at is not null
    or v_event.ticket_type not in ('coupon','lottery')
    or v_event.fixed_ticket_template_id is not null
    or v_event.referral_source_event_ticket_id is not null then
    return 0;
  end if;

  with issued as (
    insert into public.event_ticket_claims(
      claim_id,event_ticket_id,member_id,ticket_type,ticket_title,
      ticket_description,usage_method,usage_instructions,prizes
    )
    select public.new_public_id('EC'),v_event.id,m.id,v_event.ticket_type,
      v_event.title,v_event.description,v_event.usage_method,
      v_event.usage_instructions,v_event.prizes
    from public.members m
    where m.status='active' and m.membership_status='active'
      and coalesce(public.current_tier_key(m.id)=any(v_event.allowed_tier_keys),false)
      and not exists (
        select 1 from public.event_ticket_claims c
        where c.event_ticket_id=v_event.id and c.member_id=m.id
      )
      and not exists (
        select 1 from public.event_ticket_transfers t
        where t.event_ticket_id=v_event.id
          and (t.sender_member_id=m.id or t.receiver_member_id=m.id)
      )
    on conflict (event_ticket_id,member_id) do nothing
    returning id
  ) select count(*)::integer into v_issued from issued;

  if v_issued>0 then
    insert into public.audit_logs(
      audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
    ) values (
      public.new_public_id('AUD'),v_event.updated_by,'system',
      'admin.event-tickets.auto-issue','event_ticket',v_event.event_ticket_id,
      'success',jsonb_build_object('issuedCount',v_issued,'quotaMeaning','used')
    );
  end if;
  return v_issued;
end;
$body$;

create or replace function public.auto_issue_general_event_ticket()
returns trigger language plpgsql security definer set search_path = ''
as $body$
begin
  if new.status='active'
    and (tg_op='INSERT' or old.status is distinct from 'active') then
    perform public.issue_eligible_general_event_ticket(new.id);
  end if;
  return new;
end;
$body$;

-- Source-event and referral-child redemptions count against the same source quota.
-- The parent row lock serializes concurrent members across every RPC and booking path.
create or replace function public.guard_event_ticket_redemption_quota()
returns trigger language plpgsql security definer set search_path = ''
as $body$
declare
  v_source_id uuid;
  v_quota integer;
  v_used bigint;
begin
  if new.status is distinct from 'used' or old.status='used' then return new; end if;
  if new.event_ticket_id is distinct from old.event_ticket_id then
    raise exception 'EVENT_TICKET_ID_IMMUTABLE';
  end if;
  select coalesce(t.referral_source_event_ticket_id,t.id) into v_source_id
    from public.event_tickets t where t.id=new.event_ticket_id;
  if not found then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;

  select quota into v_quota from public.event_tickets
    where id=v_source_id for update;
  if not found then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  if v_quota>0 then
    select count(*) into v_used
    from public.event_ticket_claims c
    join public.event_tickets t on t.id=c.event_ticket_id
    where c.status='used' and
      (t.id=v_source_id or t.referral_source_event_ticket_id=v_source_id);
    if v_used>=v_quota then raise exception 'EVENT_USAGE_QUOTA_REACHED'; end if;
  end if;
  return new;
end;
$body$;

drop trigger if exists guard_event_ticket_redemption_quota on public.event_ticket_claims;
create trigger guard_event_ticket_redemption_quota
  before update of status on public.event_ticket_claims
  for each row execute function public.guard_event_ticket_redemption_quota();

-- A quota edit must not make previously completed redemptions exceed the cap.
create or replace function public.guard_event_ticket_quota_reduction()
returns trigger language plpgsql security definer set search_path = ''
as $body$
declare v_used bigint;
begin
  if new.quota=0 then return new; end if;
  select count(*) into v_used
  from public.event_ticket_claims c
  join public.event_tickets t on t.id=c.event_ticket_id
  where c.status='used' and
    (t.id=new.id or t.referral_source_event_ticket_id=new.id);
  if v_used>new.quota then raise exception 'EVENT_USAGE_QUOTA_BELOW_USED_COUNT'; end if;
  return new;
end;
$body$;

drop trigger if exists guard_event_ticket_quota_reduction on public.event_tickets;
create trigger guard_event_ticket_quota_reduction
  before update of quota on public.event_tickets
  for each row execute function public.guard_event_ticket_quota_reduction();

create or replace function public.event_ticket_used_counts(p_event_ids uuid[])
returns table(event_ticket_id uuid,used_count bigint)
language sql stable set search_path = ''
as $body$
  select e.id,count(c.id)::bigint
  from public.event_tickets e
  left join public.event_tickets linked
    on linked.id=e.id or linked.referral_source_event_ticket_id=e.id
  left join public.event_ticket_claims c
    on c.event_ticket_id=linked.id and c.status='used'
  where e.id=any(p_event_ids)
  group by e.id;
$body$;

-- Referral eligibility remains unchanged. Remove only its old ISSUANCE cap.
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

  select * into v_existing
  from public.member_referrals
  where invitee_member_id = v_inviter.id
  for update;

  if found then
    if v_existing.inviter_member_id <> v_invitee.id then
      raise exception 'REFERRAL_ALREADY_BOUND';
    end if;
    return jsonb_build_object(
      'referralId', v_existing.referral_id,
      'alreadyApplied', true,
      'rewardStatus', v_existing.reward_status,
      'rewardEventTicketId', (select e.event_ticket_id from public.event_tickets e where e.id=v_existing.reward_event_ticket_id),
      'rewardExpiresOn', (select e.ends_on from public.event_tickets e where e.id=v_existing.reward_event_ticket_id),
      'rewardRecipient', 'inviter',
      'inviterMemberCode', v_invitee.member_code
    );
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

  -- The authenticated actor receives the reward; the submitted code identifies the invited member.
  v_inviter_tier := public.current_tier_key(v_invitee.id);
  if not (v_inviter_tier = any(v_source_event.allowed_tier_keys)) then
    raise exception 'REFERRAL_REWARD_NOT_ELIGIBLE';
  end if;

  -- Issuance of referral rewards is unlimited; only successful redemption consumes quota.
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
    v_invitee.id,
    v_inviter.id,
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
    v_invitee.id,
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
      'inviterMemberId', v_invitee.id,
      'inviteeMemberId', v_inviter.id,
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
    'inviterMemberCode', v_invitee.member_code
  );
end;
$function$;

revoke all on function public.issue_eligible_general_event_ticket(uuid) from public,anon,authenticated;
revoke all on function public.guard_event_ticket_redemption_quota() from public,anon,authenticated;
revoke all on function public.guard_event_ticket_quota_reduction() from public,anon,authenticated;
revoke all on function public.event_ticket_used_counts(uuid[]) from public,anon,authenticated;
grant execute on function public.event_ticket_used_counts(uuid[]) to service_role;

-- Update all existing business schemas. New businesses use the same frozen blueprint.
do $tenants$
declare
  s text;
  fn record;
  ddl text;
  tpl jsonb;
  fns jsonb;
  trgs jsonb;
begin
  for s in select nspname from pg_namespace
    where nspname ~ '^business_[0-9a-f]{32}$' order by nspname loop
    if to_regclass(format('%I.event_tickets',s)) is null
      or to_regclass(format('%I.event_ticket_claims',s)) is null
      or to_regclass(format('%I.event_ticket_transfers',s)) is null
      then raise exception 'EVENT_TICKET_TENANT_SCHEMA_INCOMPLETE: %',s;
    end if;
    for fn in select p.proname,pg_get_functiondef(p.oid) definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in (
        'issue_eligible_general_event_ticket',
        'auto_issue_general_event_ticket',
        'guard_event_ticket_redemption_quota',
        'guard_event_ticket_quota_reduction',
        'event_ticket_used_counts',
        'bind_member_referral'
      ) order by p.proname loop
      ddl := replace(fn.definition,'public.',format('%I.',s));
      ddl := replace(ddl,'SET search_path TO ''public'', ''pg_temp''',
        format('SET search_path TO %L, ''pg_temp''',s));
      execute ddl;
    end loop;
    execute format('drop trigger if exists guard_event_ticket_redemption_quota on %I.event_ticket_claims',s);
    execute format('create trigger guard_event_ticket_redemption_quota before update of status on %1$I.event_ticket_claims for each row execute function %1$I.guard_event_ticket_redemption_quota()',s);
    execute format('drop trigger if exists guard_event_ticket_quota_reduction on %I.event_tickets',s);
    execute format('create trigger guard_event_ticket_quota_reduction before update of quota on %1$I.event_tickets for each row execute function %1$I.guard_event_ticket_quota_reduction()',s);
    execute format('revoke all on function %I.issue_eligible_general_event_ticket(uuid) from public,anon,authenticated',s);
    execute format('revoke all on function %I.guard_event_ticket_redemption_quota() from public,anon,authenticated',s);
    execute format('revoke all on function %I.guard_event_ticket_quota_reduction() from public,anon,authenticated',s);
    execute format('revoke all on function %I.event_ticket_used_counts(uuid[]) from public,anon,authenticated',s);
    execute format('grant execute on function %I.event_ticket_used_counts(uuid[]) to service_role',s);
  end loop;

  if to_regclass('platform_private.business_templates') is not null then
    select snapshot into tpl from platform_private.business_templates
      where version='business-v1-20261019' for update;
    if tpl is null then raise exception 'BUSINESS_TEMPLATE_MISSING'; end if;
    select coalesce(jsonb_agg(f.value order by f.ordinality),'[]'::jsonb) into fns
      from jsonb_array_elements(tpl->'functions') with ordinality f(value,ordinality)
      where f.value->>'name' not in (
        'issue_eligible_general_event_ticket','auto_issue_general_event_ticket',
        'guard_event_ticket_redemption_quota','guard_event_ticket_quota_reduction',
        'event_ticket_used_counts','bind_member_referral'
      );
    select fns||coalesce(jsonb_agg(
      jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid))
      order by p.proname
    ),'[]'::jsonb) into fns
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'issue_eligible_general_event_ticket','auto_issue_general_event_ticket',
      'guard_event_ticket_redemption_quota','guard_event_ticket_quota_reduction',
      'event_ticket_used_counts','bind_member_referral'
    );
    tpl := jsonb_set(tpl,'{functions}',fns);

    select coalesce(jsonb_agg(t.value order by t.ordinality),'[]'::jsonb) into trgs
      from jsonb_array_elements(tpl->'triggers') with ordinality t(value,ordinality)
      where t.value->>'name' not in (
        'guard_event_ticket_redemption_quota','guard_event_ticket_quota_reduction'
      );
    select trgs||coalesce(jsonb_agg(
      jsonb_build_object('name',t.tgname,'table',c.relname,'definition',pg_get_triggerdef(t.oid))
      order by t.tgname
    ),'[]'::jsonb) into trgs
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and
      (c.relname='event_ticket_claims' and t.tgname='guard_event_ticket_redemption_quota'
       or c.relname='event_tickets' and t.tgname='guard_event_ticket_quota_reduction')
      and not t.tgisinternal;
    tpl := jsonb_set(tpl,'{triggers}',trgs);
    update platform_private.business_templates set snapshot=tpl
      where version='business-v1-20261019';
  end if;

  -- Existing published campaigns previously capped issuance. Backfill those
  -- unissued eligible accounts once, idempotently, without touching used/transfer ledgers.
  perform public.issue_eligible_general_event_ticket(id)
    from public.event_tickets where status='active' and deleted_at is null
      and ticket_type in ('coupon','lottery')
      and fixed_ticket_template_id is null and referral_source_event_ticket_id is null;
  for s in select nspname from pg_namespace
    where nspname ~ '^business_[0-9a-f]{32}$' order by nspname loop
    execute format(
      'select %1$I.issue_eligible_general_event_ticket(id) from %1$I.event_tickets where status=''active'' and deleted_at is null and ticket_type in (''coupon'',''lottery'') and fixed_ticket_template_id is null and referral_source_event_ticket_id is null',s
    );
  end loop;
end;
$tenants$;

notify pgrst,'reload schema';
