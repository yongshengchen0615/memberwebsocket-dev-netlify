begin;

-- Service-only entrypoints receive identity exclusively from authenticated Edge handlers.
create table public.booking_ticket_usage_requests (
  member_id uuid not null references public.members(id) on delete cascade,
  request_id text not null,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  benefit_kind text not null check (benefit_kind in ('points','event')),
  ticket_refs text[] not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (member_id,request_id)
);
alter table public.booking_ticket_usage_requests enable row level security;
revoke all on public.booking_ticket_usage_requests from public,anon,authenticated;
grant all on public.booking_ticket_usage_requests to service_role;
create index booking_ticket_usage_requests_booking_idx on public.booking_ticket_usage_requests(booking_id);

create function public.booking_ticket_matches_services(p_booking_id uuid,p_member_id uuid,p_kind text,p_ref text)
returns boolean language sql stable set search_path = public,pg_temp as $$
  select coalesce((
    select public.booking_meets_required_services(p_booking_id,coalesce(r.required_service_ids,'{}'::uuid[]),coalesce(r.required_service_match_mode,'any'))
    from public.point_tickets pt left join public.point_card_rewards r on r.id=pt.reward_id
    where p_kind='points' and pt.member_id=p_member_id and pt.ticket_id=p_ref
    union all
    select public.booking_meets_required_services(p_booking_id,et.required_service_ids,et.required_service_match_mode)
    from public.event_ticket_claims ec join public.event_tickets et on et.id=ec.event_ticket_id
    where p_kind='event' and ec.member_id=p_member_id and ec.claim_id=p_ref
  ),false);
$$;

create function public.member_ticket_booking_options(p_member_id uuid)
returns jsonb language sql stable security definer set search_path = public,pg_temp as $$
  with tickets as (
    select 'points'::text kind,ticket_id ref from public.point_tickets where member_id=p_member_id and status='available'
    union all
    select 'event',claim_id from public.event_ticket_claims where member_id=p_member_id and status='claimed'
  ), eligible as (
    select t.kind,t.ref,coalesce(jsonb_agg(jsonb_build_object(
      'bookingId',b.id,'bookingDate',b.booking_date,'startTime',to_char(b.start_time,'HH24:MI'),
      'title',coalesce((select string_agg(bi.service_title,' + ' order by bi.created_at) from public.booking_items bi where bi.booking_id=b.id and bi.service_id<>'00000000-0000-4000-8000-000000000010'::uuid),'預約服務')
    ) order by b.booking_date,b.start_time,b.id) filter(where b.id is not null),'[]'::jsonb) bookings
    from tickets t left join public.bookings b on b.member_id=p_member_id
      and b.status='confirmed' and b.completed_at is null
      and not(b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null)
      and public.booking_ticket_matches_services(b.id,p_member_id,t.kind,t.ref)
      and not exists(select 1 from public.booking_benefit_selections s where s.member_id=p_member_id and s.benefit_kind=t.kind and s.benefit_ref=t.ref and s.status='pending')
    where exists(select 1 from public.members m where m.id=p_member_id and m.status='active' and m.membership_status='active')
    group by t.kind,t.ref
  )
  select jsonb_build_object('points',coalesce(jsonb_object_agg(ref,bookings) filter(where kind='points'),'{}'::jsonb),
    'event',coalesce(jsonb_object_agg(ref,bookings) filter(where kind='event'),'{}'::jsonb)) from eligible;
$$;

create function public.reconcile_booking_ticket_services(p_booking_id uuid)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_booking public.bookings%rowtype; v_removed jsonb;
begin
  select * into v_booking from public.bookings where id=p_booking_id for update;
  if not found or v_booking.status not in ('pending','confirmed') then return; end if;
  if exists(select 1 from public.booking_benefit_selections s where s.booking_id=p_booking_id
    and s.status='redeemed' and s.benefit_kind in ('points','event')
    and not public.booking_ticket_matches_services(p_booking_id,s.member_id,s.benefit_kind,s.benefit_ref)) then
    raise exception 'BOOKING_REDEEMED_BENEFIT_SERVICE_REQUIRED';
  end if;
  with removed as (
    update public.booking_benefit_selections s set status='cancelled',result=jsonb_build_object('cancellationReason','booking_services_changed')
    where s.booking_id=p_booking_id and s.status='pending' and s.benefit_kind in ('points','event')
      and not public.booking_ticket_matches_services(p_booking_id,s.member_id,s.benefit_kind,s.benefit_ref)
    returning s.benefit_kind,s.benefit_ref,s.title_snapshot
  ) select jsonb_agg(jsonb_build_object('kind',benefit_kind,'id',benefit_ref,'title',title_snapshot)) into v_removed from removed;
  if v_removed is not null then
    insert into public.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
    values(coalesce(nullif(current_setting('app.booking_actor',true),''),'system'),'system','BOOKING_TICKETS_RELEASED','booking',p_booking_id::text,'success',
      jsonb_build_object('reason','booking_services_changed','selections',v_removed));
  end if;
end;
$$;

create function public.reconcile_booking_ticket_services_trigger()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_id uuid; v_old_id uuid;
begin
  if tg_table_name='booking_participant_items' then
    if tg_op<>'DELETE' then select booking_id into v_id from public.booking_participants where id=new.participant_id; end if;
    if tg_op<>'INSERT' then select booking_id into v_old_id from public.booking_participants where id=old.participant_id; end if;
  else
    if tg_op<>'DELETE' then v_id:=new.booking_id; end if;
    if tg_op<>'INSERT' then v_old_id:=old.booking_id; end if;
  end if;
  if v_id is not null then perform public.reconcile_booking_ticket_services(v_id); end if;
  if v_old_id is not null and v_old_id is distinct from v_id then perform public.reconcile_booking_ticket_services(v_old_id); end if;
  return null;
end;
$$;
-- Defer until all service/participant rows have been replaced, avoiding intermediate empty bundles.
create constraint trigger booking_items_ticket_services after insert or update or delete on public.booking_items
deferrable initially deferred for each row execute function public.reconcile_booking_ticket_services_trigger();
create constraint trigger booking_participant_items_ticket_services after insert or update or delete on public.booking_participant_items
deferrable initially deferred for each row execute function public.reconcile_booking_ticket_services_trigger();
create constraint trigger booking_participants_ticket_services after insert or update or delete on public.booking_participants
deferrable initially deferred for each row execute function public.reconcile_booking_ticket_services_trigger();

-- Preserve prior selections as cancelled rows; reject newly supplied invalid tickets as before.
do $patch$
declare v_def text; v_before text; v_after text;
begin
  select pg_get_functiondef('public.replace_booking_benefit_selections_request(uuid,uuid,jsonb)'::regprocedure) into v_def;
  v_before:='  delete from public.booking_benefit_selections';
  v_after:='  perform public.reconcile_booking_ticket_services(p_booking_id);
  select coalesce(jsonb_agg(item),''[]''::jsonb) into p_selections
  from jsonb_array_elements(p_selections) item
  where not exists(select 1 from public.booking_benefit_selections s
    where s.booking_id=p_booking_id and s.member_id=p_member_id
      and s.benefit_kind=lower(btrim(item->>''kind'')) and s.benefit_ref=btrim(item->>''id'')
      and s.status=''cancelled'' and s.result->>''cancellationReason''=''booking_services_changed''
      and not public.booking_ticket_matches_services(p_booking_id,p_member_id,s.benefit_kind,s.benefit_ref));

  delete from public.booking_benefit_selections';
  if position(v_before in v_def)=0 then raise exception 'BOOKING_TICKET_SELECTION_PATCH_MISSING'; end if;
  v_def:=replace(v_def,v_before,v_after);
  v_before:='left(v_title,200),''pending''
    );';
  v_after:='left(v_title,200),''pending''
    ) on conflict (booking_id,benefit_kind,benefit_ref) do update
      set status=''pending'',selected_at=now(),title_snapshot=excluded.title_snapshot,result=null
      where booking_benefit_selections.status=''cancelled'';';
  if position(v_before in v_def)=0 then raise exception 'BOOKING_TICKET_RESELECT_PATCH_MISSING'; end if;
  execute replace(v_def,v_before,v_after);
end $patch$;

create function public.redeem_member_tickets_for_booking_request(
  p_line_user_id text,p_booking_id uuid,p_kind text,p_refs text[],p_request_id text,p_location jsonb default null
) returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare
  v_booking public.bookings%rowtype; v_member public.members%rowtype;
  v_previous public.booking_ticket_usage_requests%rowtype; v_refs text[]; v_ref text; v_result jsonb;
begin
  if p_kind not in ('points','event') or p_kind is null or coalesce(cardinality(p_refs),0) not between 1 and 50
    or exists(select 1 from unnest(p_refs) ref where ref is null or btrim(ref)='' or length(ref)>160)
    or (select count(distinct ref) from unnest(p_refs) ref)<>cardinality(p_refs) then raise exception 'INVALID_TICKET_BATCH'; end if;
  if p_request_id is null or p_request_id!~'^[A-Za-z0-9_-]{8,120}$' then raise exception 'INVALID_REQUEST_ID'; end if;
  select array_agg(ref order by ref) into v_refs from unnest(p_refs) ref;
  -- Match completion/edit lock order: booking, member, tickets, then balances/inventory.
  select * into v_booking from public.bookings where id=p_booking_id for update;
  select * into v_member from public.members where line_user_id=p_line_user_id for update;
  if not found or v_member.status<>'active' or v_member.membership_status<>'active' then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  if v_booking.id is null or v_booking.member_id<>v_member.id then raise exception 'BOOKING_NOT_OWNED'; end if;
  select * into v_previous from public.booking_ticket_usage_requests where member_id=v_member.id and request_id=p_request_id;
  if found then
    if v_previous.booking_id<>p_booking_id or v_previous.benefit_kind<>p_kind or v_previous.ticket_refs<>v_refs then raise exception 'REQUEST_ID_CONFLICT'; end if;
    return v_previous.result||jsonb_build_object('alreadyApplied',true);
  end if;
  if v_booking.status<>'confirmed' or v_booking.completed_at is not null then raise exception 'BOOKING_TICKET_CONFIRMATION_REQUIRED'; end if;
  if v_booking.cancellation_requested_at is not null and v_booking.cancellation_reviewed_at is null then raise exception 'BOOKING_CANCELLATION_PENDING'; end if;
  if p_kind='points' then
    perform 1 from public.point_tickets where member_id=v_member.id and ticket_id=any(v_refs) order by ticket_id for update;
  else
    perform 1 from public.event_ticket_claims where member_id=v_member.id and claim_id=any(v_refs) order by claim_id for update;
  end if;
  if exists(select 1 from public.booking_benefit_selections s where s.member_id=v_member.id and s.benefit_kind=p_kind and s.benefit_ref=any(v_refs) and s.status='pending') then
    raise exception 'BOOKING_BENEFIT_RESERVED';
  end if;
  foreach v_ref in array v_refs loop
    if not public.booking_ticket_matches_services(p_booking_id,v_member.id,p_kind,v_ref) then raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'; end if;
  end loop;
  if p_kind='points' then
    v_result:=public.redeem_point_tickets_with_location(p_line_user_id,v_refs,'BTU_'||md5(v_member.id::text||p_request_id),p_location);
  else
    v_result:=public.redeem_event_tickets_with_location(p_line_user_id,v_refs,'BTU_'||md5(v_member.id::text||p_request_id),p_location);
  end if;
  foreach v_ref in array v_refs loop
    insert into public.booking_benefit_selections(booking_id,member_id,benefit_kind,benefit_ref,title_snapshot,status,redeemed_at,redeemed_by,result)
    values(p_booking_id,v_member.id,p_kind,v_ref,coalesce(
      case when p_kind='points' then (select ticket_title from public.point_tickets where ticket_id=v_ref and member_id=v_member.id)
        else (select ticket_title from public.event_ticket_claims where claim_id=v_ref and member_id=v_member.id) end,''),
      'redeemed',now(),p_line_user_id,v_result)
    on conflict(booking_id,benefit_kind,benefit_ref) do update set status='redeemed',redeemed_at=excluded.redeemed_at,redeemed_by=excluded.redeemed_by,result=excluded.result
      where booking_benefit_selections.status='cancelled';
  end loop;
  insert into public.booking_ticket_usage_requests values(v_member.id,p_request_id,p_booking_id,p_kind,v_refs,v_result,now());
  insert into public.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
    values(p_line_user_id,'member','BOOKING_TICKETS_REDEEMED','booking',p_booking_id::text,'success',jsonb_build_object('kind',p_kind,'refs',v_refs,'requestId',p_request_id));
  return v_result;
end;
$$;

revoke all on function public.booking_ticket_matches_services(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.member_ticket_booking_options(uuid) from public,anon,authenticated;
revoke all on function public.reconcile_booking_ticket_services(uuid) from public,anon,authenticated;
revoke all on function public.reconcile_booking_ticket_services_trigger() from public,anon,authenticated;
revoke all on function public.redeem_member_tickets_for_booking_request(text,uuid,text,text[],text,jsonb) from public,anon,authenticated;
grant execute on function public.booking_ticket_matches_services(uuid,uuid,text,text),public.member_ticket_booking_options(uuid),
  public.reconcile_booking_ticket_services(uuid),public.reconcile_booking_ticket_services_trigger(),
  public.redeem_member_tickets_for_booking_request(text,uuid,text,text[],text,jsonb) to service_role;

commit;
