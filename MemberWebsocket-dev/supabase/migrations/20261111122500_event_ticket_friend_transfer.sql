-- Transfer only a previously claimed general event ticket between accepted friends.
-- The ledger prevents reclaiming a ticket after giving it away and makes retries idempotent.
create table if not exists public.event_ticket_transfers (
  id uuid primary key default gen_random_uuid(),
  event_ticket_id uuid not null references public.event_tickets(id) on delete cascade,
  claim_id text not null,
  sender_member_id uuid references public.members(id) on delete set null,
  receiver_member_id uuid references public.members(id) on delete set null,
  request_id text not null check (length(btrim(request_id)) between 8 and 120),
  created_at timestamptz not null default now(),
  unique (sender_member_id, request_id)
);

create index if not exists event_ticket_transfers_sender_history_idx
  on public.event_ticket_transfers(event_ticket_id, sender_member_id);
create index if not exists event_ticket_transfers_receiver_history_idx
  on public.event_ticket_transfers(event_ticket_id, receiver_member_id);

alter table public.event_ticket_transfers enable row level security;
revoke all on public.event_ticket_transfers from public, anon, authenticated;
grant select on public.event_ticket_transfers to service_role;

-- A sender no longer holds a claim after ownership moves. Do not let the
-- original holder (or a previous recipient) claim a fresh copy afterwards.
create or replace function public.prevent_event_ticket_reclaim_after_transfer()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from public.event_ticket_transfers t
    where t.event_ticket_id = new.event_ticket_id
      and (t.sender_member_id = new.member_id or t.receiver_member_id = new.member_id)
  ) then
    raise exception 'EVENT_TICKET_ALREADY_TRANSFERRED';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_event_ticket_reclaim_after_transfer on public.event_ticket_claims;
create trigger prevent_event_ticket_reclaim_after_transfer
  before insert on public.event_ticket_claims
  for each row execute function public.prevent_event_ticket_reclaim_after_transfer();

revoke all on function public.prevent_event_ticket_reclaim_after_transfer() from public, anon, authenticated;

create or replace function public.transfer_event_ticket_to_friend(
  p_actor_line_user_id text,
  p_claim_id text,
  p_receiver_member_code text,
  p_request_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_sender public.members%rowtype;
  v_receiver public.members%rowtype;
  v_claim public.event_ticket_claims%rowtype;
  v_ticket public.event_tickets%rowtype;
  v_prior public.event_ticket_transfers%rowtype;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
begin
  if p_claim_id is null or length(btrim(p_claim_id)) not between 1 and 120
     or p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then
    raise exception 'INVALID_TICKET_TRANSFER_REQUEST';
  end if;

  select * into v_sender from public.members
    where line_user_id = p_actor_line_user_id
      and status = 'active' and membership_status = 'active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  -- Serialize retries with the same request id; a retry may not change its recipient.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_sender.id::text || ':' || p_request_id, 62061)
  );
  select * into v_prior from public.event_ticket_transfers
    where sender_member_id = v_sender.id and request_id = p_request_id;
  if found then
    if v_prior.claim_id <> p_claim_id
      or not exists (
        select 1 from public.members m where m.id = v_prior.receiver_member_id
          and upper(m.member_code) = upper(btrim(p_receiver_member_code))
      ) then
      raise exception 'TICKET_TRANSFER_REQUEST_CONFLICT';
    end if;
    return jsonb_build_object('claimId', v_prior.claim_id, 'alreadyTransferred', true);
  end if;

  -- Unknown members, blocked accounts, pending requests and cross-test-account
  -- recipients all return the same error to avoid account enumeration.
  if p_receiver_member_code is null
     or p_receiver_member_code !~* '^[A-Z0-9_-]{4,40}$' then
    raise exception 'EVENT_TICKET_FRIEND_REQUIRED';
  end if;
  select * into v_receiver from public.members
    where upper(member_code) = upper(btrim(p_receiver_member_code))
      and status = 'active' and membership_status = 'active'
      and is_test_account = v_sender.is_test_account
      and id <> v_sender.id;
  if not found then raise exception 'EVENT_TICKET_FRIEND_REQUIRED'; end if;

  perform 1 from public.member_friendships f
    where f.member_a = least(v_sender.id, v_receiver.id)
      and f.member_b = greatest(v_sender.id, v_receiver.id)
      and f.status = 'accepted'
    for share;
  if not found then raise exception 'EVENT_TICKET_FRIEND_REQUIRED'; end if;

  -- Lock the campaign before the claim: claim_event_ticket takes this same lock.
  -- This prevents a parallel reclaim between ownership change and ledger insert.
  select e.* into v_ticket from public.event_tickets e
    join public.event_ticket_claims c on c.event_ticket_id = e.id
    where c.claim_id = p_claim_id for update of e;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;

  select * into v_claim from public.event_ticket_claims
    where claim_id = p_claim_id for update;
  if not found or v_claim.member_id <> v_sender.id then
    raise exception 'EVENT_TICKET_TRANSFER_NOT_OWNED';
  end if;
  if v_claim.status <> 'claimed'
     or v_ticket.status <> 'active' or v_ticket.deleted_at is not null
     or (v_ticket.ends_on is not null and v_ticket.ends_on < v_today) then
    raise exception 'EVENT_TICKET_TRANSFER_NOT_AVAILABLE';
  end if;
  -- Fixed, referral and membership-join tickets have independent grant ownership.
  if v_ticket.fixed_ticket_template_id is not null
     or v_ticket.ticket_type not in ('coupon', 'lottery') then
    raise exception 'EVENT_TICKET_TRANSFER_RESTRICTED';
  end if;
  if not coalesce(public.current_tier_key(v_receiver.id) = any(v_ticket.allowed_tier_keys), false) then
    raise exception 'TIER_NOT_ALLOWED';
  end if;

  if exists (
    select 1 from public.event_ticket_claims c
      where c.event_ticket_id = v_ticket.id and c.member_id = v_receiver.id
  ) or exists (
    select 1 from public.event_ticket_transfers t
      where t.event_ticket_id = v_ticket.id
        and (t.sender_member_id = v_receiver.id or t.receiver_member_id = v_receiver.id)
  ) then
    raise exception 'EVENT_TICKET_RECEIVER_ALREADY_OWNED';
  end if;

  -- Pending selections and snapshots must not be moved away from the booking owner.
  if exists (
    select 1 from public.booking_benefit_selections s
      where s.member_id = v_sender.id and s.benefit_kind = 'event'
        and s.benefit_ref = v_claim.claim_id and s.status = 'pending'
  ) or exists (
    select 1 from public.booking_receipts r
      where r.member_id = v_sender.id and r.submission_mode = 'accessible'
        and r.status in ('pending_upload','awaiting_review')
        and r.requested_benefits @> jsonb_build_array(
          jsonb_build_object('kind','event','id',v_claim.claim_id)
        )
  ) then
    raise exception 'EVENT_TICKET_TRANSFER_RESERVED';
  end if;

  update public.event_ticket_claims
    set member_id = v_receiver.id, updated_at = clock_timestamp()
    where id = v_claim.id and member_id = v_sender.id and status = 'claimed';
  if not found then raise exception 'EVENT_TICKET_TRANSFER_NOT_AVAILABLE'; end if;

  insert into public.event_ticket_transfers (
    event_ticket_id, claim_id, sender_member_id, receiver_member_id, request_id
  ) values (v_ticket.id, v_claim.claim_id, v_sender.id, v_receiver.id, p_request_id);

  return jsonb_build_object('claimId', v_claim.claim_id, 'alreadyTransferred', false);
end;
$$;

revoke all on function public.transfer_event_ticket_to_friend(text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.transfer_event_ticket_to_friend(text,text,text,text)
  to service_role;
