begin;

alter table public.event_tickets
  drop constraint if exists event_tickets_ticket_type_check;
alter table public.event_tickets
  add constraint event_tickets_ticket_type_check
  check (ticket_type = any (array['coupon'::text, 'lottery'::text, 'referral'::text, 'membership_join'::text]));

alter table public.event_ticket_claims
  drop constraint if exists event_ticket_claims_ticket_type_check;
alter table public.event_ticket_claims
  add constraint event_ticket_claims_ticket_type_check
  check (ticket_type = any (array['coupon'::text, 'lottery'::text, 'referral'::text, 'membership_join'::text]));

alter table public.event_tickets
  drop constraint if exists event_tickets_redemption_location_valid;
alter table public.event_tickets
  add constraint event_tickets_redemption_location_valid
  check (
    (
      requires_location = false
      and redemption_latitude is null
      and redemption_longitude is null
      and redemption_radius_meters is null
    )
    or
    (
      requires_location = true
      and ticket_type = any (array['coupon'::text, 'membership_join'::text])
      and redemption_latitude is not null
      and redemption_longitude is not null
      and redemption_radius_meters is not null
      and redemption_latitude >= -90
      and redemption_latitude <= 90
      and redemption_longitude >= -180
      and redemption_longitude <= 180
      and redemption_radius_meters >= 50
      and redemption_radius_meters <= 2000
    )
  );

alter table public.event_tickets
  drop constraint if exists event_tickets_redemption_locations_valid;
alter table public.event_tickets
  add constraint event_tickets_redemption_locations_valid
  check (
    (
      not requires_location
      and redemption_locations = '[]'::jsonb
    )
    or
    (
      requires_location
      and ticket_type = any (array['coupon'::text, 'membership_join'::text])
      and public.event_ticket_locations_valid(redemption_locations)
    )
  );

create unique index if not exists event_tickets_one_active_membership_join_idx
  on public.event_tickets (ticket_type)
  where ticket_type = 'membership_join'
    and status = 'active'
    and deleted_at is null;

create or replace function public.issue_membership_join_ticket(
  p_member_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.members%rowtype;
  v_event public.event_tickets%rowtype;
  v_existing_claim public.event_ticket_claims%rowtype;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_tier text;
  v_claim_count integer := 0;
  v_claim_id text;
begin
  select * into v_member
  from public.members
  where id = p_member_id
  for update;

  if not found
     or v_member.status <> 'active'
     or v_member.membership_status <> 'active' then
    return jsonb_build_object(
      'issued', false,
      'alreadyApplied', false,
      'reason', 'member_not_active'
    );
  end if;

  select * into v_event
  from public.event_tickets
  where ticket_type = 'membership_join'
    and status = 'active'
    and deleted_at is null
    and (starts_on is null or starts_on <= v_today)
    and (ends_on is null or ends_on >= v_today)
  order by created_at desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object(
      'issued', false,
      'alreadyApplied', false,
      'reason', 'not_configured'
    );
  end if;

  select * into v_existing_claim
  from public.event_ticket_claims
  where event_ticket_id = v_event.id
    and member_id = v_member.id
  for update;

  if found then
    return jsonb_build_object(
      'issued', true,
      'alreadyApplied', true,
      'reason', 'already_issued',
      'claimId', v_existing_claim.claim_id,
      'eventTicketId', v_event.event_ticket_id
    );
  end if;

  v_tier := public.current_tier_key(v_member.id);
  if v_tier is null or not (v_tier = any(v_event.allowed_tier_keys)) then
    return jsonb_build_object(
      'issued', false,
      'alreadyApplied', false,
      'reason', 'tier_not_allowed',
      'eventTicketId', v_event.event_ticket_id
    );
  end if;

  if v_event.quota > 0 then
    select count(*)::integer into v_claim_count
    from public.event_ticket_claims
    where event_ticket_id = v_event.id;

    if v_claim_count >= v_event.quota then
      return jsonb_build_object(
        'issued', false,
        'alreadyApplied', false,
        'reason', 'sold_out',
        'eventTicketId', v_event.event_ticket_id
      );
    end if;
  end if;

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
    v_event.id,
    v_member.id,
    'membership_join',
    v_event.title,
    v_event.description,
    v_event.usage_method,
    v_event.usage_instructions,
    v_event.prizes,
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
    null,
    'system',
    'system.member.membership-join-ticket.issue',
    'member',
    v_member.line_user_id,
    'success',
    jsonb_build_object(
      'memberId', v_member.id,
      'claimId', v_claim_id,
      'eventTicketId', v_event.event_ticket_id,
      'ticketType', 'membership_join'
    )
  );

  insert into public.realtime_events(scope,event_type)
  values ('event','member.membership-join-ticket-issued');

  return jsonb_build_object(
    'issued', true,
    'alreadyApplied', false,
    'reason', 'issued',
    'claimId', v_claim_id,
    'eventTicketId', v_event.event_ticket_id
  );
end;
$$;

revoke all on function public.issue_membership_join_ticket(uuid) from public, anon, authenticated;
grant execute on function public.issue_membership_join_ticket(uuid) to service_role;

create or replace function public.issue_membership_join_ticket_after_activation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.membership_status = 'active'
     and new.status = 'active'
     and (
       tg_op = 'INSERT'
       or old.membership_status is distinct from 'active'
     ) then
    begin
      perform public.issue_membership_join_ticket(new.id);
    exception when others then
      begin
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
          null,
          'system',
          'system.member.membership-join-ticket.issue',
          'member',
          new.line_user_id,
          'failed',
          jsonb_build_object(
            'memberId', new.id,
            'sqlState', sqlstate
          )
        );
      exception when others then
        null;
      end;
    end;
  end if;

  return new;
end;
$$;

drop trigger if exists members_issue_membership_join_ticket on public.members;
create trigger members_issue_membership_join_ticket
after insert or update of membership_status on public.members
for each row
execute function public.issue_membership_join_ticket_after_activation();

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
  if v_event.ticket_type = 'membership_join' then raise exception 'MEMBERSHIP_JOIN_TICKET_AUTO_ONLY'; end if;

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

revoke all on function public.claim_event_ticket(text,text) from public, anon, authenticated;
grant execute on function public.claim_event_ticket(text,text) to service_role;

commit;
