create table if not exists public.point_card_settings (
  id smallint primary key default 1 check (id = 1),
  max_tickets_per_redemption integer not null default 1 check (max_tickets_per_redemption between 1 and 50),
  updated_by text not null default 'system',
  updated_at timestamptz not null default now()
);

alter table public.point_card_settings enable row level security;
revoke all on table public.point_card_settings from anon, authenticated;

insert into public.point_card_settings(id, max_tickets_per_redemption, updated_by)
values (1, 1, 'migration')
on conflict (id) do nothing;

create or replace function public.redeem_point_tickets(p_line_user_id text, p_ticket_ids text[], p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_member public.members%rowtype;
  v_ticket public.point_tickets%rowtype;
  v_card public.point_cards%rowtype;
  v_balance public.point_balances%rowtype;
  v_result jsonb := null;
  v_entry_id uuid;
  v_selected_count integer := 0;
  v_total_points integer := 0;
  v_processed integer := 0;
  v_global_max_tickets integer := 1;
  v_points_by_card jsonb := '{}'::jsonb;
  v_existing jsonb;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then raise exception 'INVALID_REQUEST_ID'; end if;
  if p_ticket_ids is null or cardinality(p_ticket_ids) < 1 or cardinality(p_ticket_ids) > 50 then raise exception 'INVALID_TICKET_BATCH'; end if;
  if exists(select 1 from unnest(p_ticket_ids) as selected(ticket_id) where nullif(btrim(selected.ticket_id),'') is null) then raise exception 'INVALID_TICKET_BATCH'; end if;
  if (select count(distinct selected.ticket_id) from unnest(p_ticket_ids) as selected(ticket_id)) <> cardinality(p_ticket_ids) then raise exception 'INVALID_TICKET_BATCH'; end if;

  select max_tickets_per_redemption into v_global_max_tickets
  from public.point_card_settings
  where id = 1;
  v_global_max_tickets := coalesce(v_global_max_tickets, 1);
  if cardinality(p_ticket_ids) > v_global_max_tickets then raise exception 'TICKET_BATCH_LIMIT_EXCEEDED'; end if;

  select * into v_member from public.members
  where line_user_id=p_line_user_id and membership_status='active' and status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select detail into v_existing
  from public.audit_logs
  where actor_line_user_id=v_member.line_user_id
    and action='user.pointcard.tickets.redeem'
    and target_type='point_ticket_batch'
    and target_id=p_request_id
    and result='success'
  order by created_at desc
  limit 1;
  if found then
    return coalesce(v_existing,'{}'::jsonb) || jsonb_build_object('requestId',p_request_id,'alreadyApplied',true);
  end if;

  perform 1 from public.point_tickets pt
  where pt.member_id=v_member.id and pt.ticket_id=any(p_ticket_ids)
  order by pt.ticket_id
  for update;

  select count(*) into v_selected_count from public.point_tickets pt
  where pt.member_id=v_member.id and pt.ticket_id=any(p_ticket_ids);
  if v_selected_count <> cardinality(p_ticket_ids) then raise exception 'TICKET_NOT_FOUND'; end if;
  if exists(select 1 from public.point_tickets pt where pt.member_id=v_member.id and pt.ticket_id=any(p_ticket_ids) and pt.status <> 'available') then
    raise exception 'TICKET_NOT_AVAILABLE';
  end if;

  perform 1 from public.point_cards pc
  where pc.id in (select pt.point_card_id from public.point_tickets pt where pt.member_id=v_member.id and pt.ticket_id=any(p_ticket_ids))
  order by pc.id
  for update;

  for v_card in
    select pc.* from public.point_cards pc
    where pc.id in (select pt.point_card_id from public.point_tickets pt where pt.member_id=v_member.id and pt.ticket_id=any(p_ticket_ids))
    order by pc.id
  loop
    if v_card.status <> 'active' then raise exception 'POINT_CARD_NOT_AVAILABLE'; end if;
    if v_card.expiry_mode='date' and v_card.expires_on < (now() at time zone 'Asia/Taipei')::date then raise exception 'POINT_CARD_EXPIRED'; end if;

    select coalesce(sum(pt.threshold_stamps),0)::integer
      into v_total_points
    from public.point_tickets pt
    where pt.member_id=v_member.id and pt.ticket_id=any(p_ticket_ids) and pt.point_card_id=v_card.id;

    select * into v_balance from public.point_balances
    where member_id=v_member.id and point_card_id=v_card.id
    for update;
    if not found or v_balance.stamps < v_total_points then raise exception 'INSUFFICIENT_POINTS'; end if;
  end loop;

  for v_ticket in
    select pt.* from public.point_tickets pt
    where pt.member_id=v_member.id and pt.ticket_id=any(p_ticket_ids)
    order by pt.point_card_id,pt.ticket_id
  loop
    v_result := null;
    if v_ticket.ticket_type='lottery' then v_result := public.pick_lottery_prize(v_ticket.prizes); end if;

    update public.point_balances
    set stamps=stamps-v_ticket.threshold_stamps,updated_at=now()
    where member_id=v_member.id and point_card_id=v_ticket.point_card_id;

    insert into public.point_entries(entry_id,member_id,point_card_id,amount,note,created_by,request_id,entry_type,reference_type,reference_id)
    values(public.new_public_id('PE'),v_member.id,v_ticket.point_card_id,-v_ticket.threshold_stamps,'票券批次核銷',v_member.line_user_id,
      p_request_id||':'||v_ticket.ticket_id,'redeem','point_ticket',v_ticket.ticket_id)
    returning id into v_entry_id;

    update public.point_tickets
    set status='used',used_at=now(),result=v_result,points_spent=v_ticket.threshold_stamps,redeem_entry_id=v_entry_id,updated_at=now()
    where id=v_ticket.id;
    v_processed := v_processed + 1;
  end loop;

  for v_card in
    select pc.* from public.point_cards pc
    where pc.id in (select pt.point_card_id from public.point_tickets pt where pt.member_id=v_member.id and pt.ticket_id=any(p_ticket_ids))
    order by pc.id
  loop
    perform public.issue_eligible_point_tickets(v_member.id,v_card.id);
  end loop;

  select coalesce(jsonb_object_agg(totals.card_id,totals.points_spent),'{}'::jsonb)
    into v_points_by_card
  from (
    select pc.card_id,sum(pt.threshold_stamps)::integer as points_spent
    from public.point_tickets pt join public.point_cards pc on pc.id=pt.point_card_id
    where pt.member_id=v_member.id and pt.ticket_id=any(p_ticket_ids)
    group by pc.card_id
  ) totals;

  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
  values(public.new_public_id('AUD'),v_member.line_user_id,'member','user.pointcard.tickets.redeem','point_ticket_batch',p_request_id,'success',
    jsonb_build_object('requestId',p_request_id,'ticketIds',to_jsonb(p_ticket_ids),'ticketCount',v_processed,'pointsByCard',v_points_by_card,'globalMaxTicketsPerRedemption',v_global_max_tickets,'alreadyApplied',false));

  return jsonb_build_object('requestId',p_request_id,'ticketIds',to_jsonb(p_ticket_ids),'ticketCount',v_processed,'pointsByCard',v_points_by_card,'globalMaxTicketsPerRedemption',v_global_max_tickets,'alreadyApplied',false);
end;
$function$;

revoke all on function public.redeem_point_tickets(text,text[],text) from public, anon, authenticated;
grant execute on function public.redeem_point_tickets(text,text[],text) to service_role;
