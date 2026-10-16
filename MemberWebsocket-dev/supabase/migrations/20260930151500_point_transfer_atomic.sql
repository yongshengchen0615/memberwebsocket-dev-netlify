begin;

create table if not exists public.point_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_id text not null unique,
  request_id text not null,
  sender_member_id uuid not null references public.members(id) on delete restrict,
  receiver_member_id uuid not null references public.members(id) on delete restrict,
  point_card_id uuid not null references public.point_cards(id) on delete restrict,
  amount integer not null,
  created_at timestamptz not null default now(),
  constraint point_transfers_positive_amount check (amount > 0),
  constraint point_transfers_not_self check (sender_member_id <> receiver_member_id),
  constraint point_transfers_request_id_check check (request_id ~ '^[A-Za-z0-9_-]{8,120}$'),
  constraint point_transfers_sender_request_unique unique(sender_member_id, request_id)
);

create index if not exists point_transfers_sender_created_idx
  on public.point_transfers(sender_member_id, created_at desc);
create index if not exists point_transfers_receiver_created_idx
  on public.point_transfers(receiver_member_id, created_at desc);
create index if not exists point_transfers_card_created_idx
  on public.point_transfers(point_card_id, created_at desc);

alter table public.point_transfers enable row level security;

create or replace function public.lookup_point_transfer_receiver(
  p_sender_line_user_id text,
  p_receiver_member_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sender public.members%rowtype;
  v_receiver public.members%rowtype;
begin
  select * into v_sender
  from public.members
  where line_user_id=p_sender_line_user_id
    and status='active'
    and membership_status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select * into v_receiver
  from public.members
  where upper(member_code)=upper(btrim(coalesce(p_receiver_member_code,'')))
    and status='active'
    and membership_status='active';
  if not found then raise exception 'TRANSFER_RECEIVER_NOT_FOUND'; end if;
  if v_sender.id=v_receiver.id then raise exception 'TRANSFER_SELF_NOT_ALLOWED'; end if;

  return jsonb_build_object(
    'memberCode',v_receiver.member_code,
    'displayName',coalesce(v_receiver.display_name,'')
  );
end;
$$;

create or replace function public.transfer_member_points(
  p_sender_line_user_id text,
  p_receiver_member_code text,
  p_card_id text,
  p_amount integer,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sender public.members%rowtype;
  v_receiver public.members%rowtype;
  v_card public.point_cards%rowtype;
  v_existing public.point_transfers%rowtype;
  v_sender_balance integer;
  v_receiver_balance integer;
  v_transfer_id text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
begin
  p_receiver_member_code:=btrim(coalesce(p_receiver_member_code,''));
  p_card_id:=btrim(coalesce(p_card_id,''));
  p_request_id:=btrim(coalesce(p_request_id,''));

  if p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then raise exception 'INVALID_REQUEST_ID'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_TRANSFER_AMOUNT'; end if;
  if p_receiver_member_code='' then raise exception 'TRANSFER_RECEIVER_REQUIRED'; end if;
  if p_card_id='' then raise exception 'POINT_CARD_REQUIRED'; end if;

  select * into v_sender
  from public.members
  where line_user_id=p_sender_line_user_id
    and status='active'
    and membership_status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select * into v_receiver
  from public.members
  where upper(member_code)=upper(p_receiver_member_code)
    and status='active'
    and membership_status='active';
  if not found then raise exception 'TRANSFER_RECEIVER_NOT_FOUND'; end if;
  if v_sender.id=v_receiver.id then raise exception 'TRANSFER_SELF_NOT_ALLOWED'; end if;

  perform 1
  from public.members
  where id in (v_sender.id,v_receiver.id)
  order by id
  for update;

  select * into v_card
  from public.point_cards
  where card_id=p_card_id
  for update;
  if not found then raise exception 'POINT_CARD_NOT_FOUND'; end if;
  if v_card.status<>'active' then raise exception 'POINT_CARD_NOT_AVAILABLE'; end if;
  if v_card.expiry_mode='date' and (v_card.expires_on is null or v_card.expires_on<v_today) then
    raise exception 'POINT_CARD_EXPIRED';
  end if;

  select * into v_existing
  from public.point_transfers
  where sender_member_id=v_sender.id
    and request_id=p_request_id
  for update;
  if found then
    if v_existing.receiver_member_id<>v_receiver.id
       or v_existing.point_card_id<>v_card.id
       or v_existing.amount<>p_amount then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    select stamps into v_sender_balance from public.point_balances
      where member_id=v_sender.id and point_card_id=v_card.id;
    select stamps into v_receiver_balance from public.point_balances
      where member_id=v_receiver.id and point_card_id=v_card.id;
    return jsonb_build_object(
      'transferId',v_existing.transfer_id,
      'requestId',p_request_id,
      'cardId',v_card.card_id,
      'amount',v_existing.amount,
      'receiverMemberCode',v_receiver.member_code,
      'senderBalance',coalesce(v_sender_balance,0),
      'receiverBalance',coalesce(v_receiver_balance,0),
      'alreadyApplied',true
    );
  end if;

  insert into public.point_balances(member_id,point_card_id,stamps,updated_at)
  values(v_receiver.id,v_card.id,0,now())
  on conflict (member_id,point_card_id) do nothing;

  perform 1
  from public.point_balances
  where point_card_id=v_card.id
    and member_id in (v_sender.id,v_receiver.id)
  order by member_id
  for update;

  select stamps into v_sender_balance
  from public.point_balances
  where member_id=v_sender.id and point_card_id=v_card.id;
  if not found or v_sender_balance<p_amount then raise exception 'INSUFFICIENT_POINTS'; end if;

  update public.point_balances
  set stamps=stamps-p_amount,updated_at=now()
  where member_id=v_sender.id and point_card_id=v_card.id
  returning stamps into v_sender_balance;

  update public.point_balances
  set stamps=stamps+p_amount,updated_at=now()
  where member_id=v_receiver.id and point_card_id=v_card.id
  returning stamps into v_receiver_balance;

  v_transfer_id:=public.new_public_id('PT');
  insert into public.point_transfers(
    transfer_id,request_id,sender_member_id,receiver_member_id,point_card_id,amount
  ) values (
    v_transfer_id,p_request_id,v_sender.id,v_receiver.id,v_card.id,p_amount
  );

  insert into public.point_entries(
    entry_id,member_id,point_card_id,amount,note,created_by,request_id,entry_type,reference_type,reference_id
  ) values (
    public.new_public_id('PE'),v_sender.id,v_card.id,-p_amount,'會員點數轉贈',v_sender.line_user_id,
    p_request_id,'transfer_out','point_transfer',v_transfer_id
  );

  insert into public.point_entries(
    entry_id,member_id,point_card_id,amount,note,created_by,request_id,entry_type,reference_type,reference_id
  ) values (
    public.new_public_id('PE'),v_receiver.id,v_card.id,p_amount,'收到會員點數轉贈',v_sender.line_user_id,
    p_request_id,'transfer_in','point_transfer',v_transfer_id
  );

  perform public.issue_eligible_point_tickets(v_receiver.id,v_card.id);

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values (
    public.new_public_id('AUD'),v_sender.line_user_id,'member','user.pointcard.transfer',
    'point_transfer',v_transfer_id,'success',
    jsonb_build_object(
      'senderMemberId',v_sender.id,
      'receiverMemberId',v_receiver.id,
      'pointCardId',v_card.card_id,
      'amount',p_amount,
      'requestId',p_request_id
    )
  );

  insert into public.realtime_events(scope,event_type)
  values('points','point.transfer');

  return jsonb_build_object(
    'transferId',v_transfer_id,
    'requestId',p_request_id,
    'cardId',v_card.card_id,
    'amount',p_amount,
    'receiverMemberCode',v_receiver.member_code,
    'senderBalance',v_sender_balance,
    'receiverBalance',v_receiver_balance,
    'alreadyApplied',false
  );
end;
$$;

revoke all on function public.lookup_point_transfer_receiver(text,text) from public,anon,authenticated;
grant execute on function public.lookup_point_transfer_receiver(text,text) to service_role;
revoke all on function public.transfer_member_points(text,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.transfer_member_points(text,text,text,integer,text) to service_role;

commit;
