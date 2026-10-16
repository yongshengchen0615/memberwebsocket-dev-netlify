begin;

alter table public.event_ticket_settings
  add column if not exists max_tickets_per_day integer;

update public.event_ticket_settings
set max_tickets_per_day = coalesce(max_tickets_per_day, max_tickets_per_redemption, 1)
where max_tickets_per_day is null;

alter table public.event_ticket_settings
  alter column max_tickets_per_day set default 1,
  alter column max_tickets_per_day set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_ticket_settings_max_tickets_per_day_check'
      and conrelid = 'public.event_ticket_settings'::regclass
  ) then
    alter table public.event_ticket_settings
      add constraint event_ticket_settings_max_tickets_per_day_check
      check (max_tickets_per_day between 1 and 50);
  end if;
end $$;

comment on column public.event_ticket_settings.max_tickets_per_day
is 'Maximum number of event tickets one member may redeem per Asia/Taipei business date.';

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

  select coalesce(max_tickets_per_day, max_tickets_per_redemption, 1)
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

  v_remaining_today := greatest(v_max_tickets - v_used_today_count, 0);

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
$function$;

CREATE OR REPLACE FUNCTION public.redeem_event_ticket(p_line_user_id text, p_claim_id text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select public.redeem_event_ticket(p_line_user_id,p_claim_id,null::jsonb);
$function$;

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

  select coalesce(max_tickets_per_day, max_tickets_per_redemption, 1)
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

  if v_used_today_count >= v_max_tickets then
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
    'remainingTodayCount',greatest(v_max_tickets - (v_used_today_count + 1),0)
  );
end;
$function$;

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

  select coalesce(max_tickets_per_day, max_tickets_per_redemption, 1)
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

  if v_used_today_count + cardinality(p_claim_ids) > v_max_tickets then
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
    'remainingTodayCount',greatest(v_max_tickets - (v_used_today_count + v_processed),0),
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
$function$;

revoke all on function public.count_today_usable_event_tickets(text) from public,anon,authenticated;
grant execute on function public.count_today_usable_event_tickets(text) to service_role;
revoke all on function public.redeem_event_ticket(text,text) from public,anon,authenticated;
grant execute on function public.redeem_event_ticket(text,text) to service_role;
revoke all on function public.redeem_event_ticket(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.redeem_event_ticket(text,text,jsonb) to service_role;
revoke all on function public.redeem_event_tickets_with_location(text,text[],text,jsonb) from public,anon,authenticated;
grant execute on function public.redeem_event_tickets_with_location(text,text[],text,jsonb) to service_role;

commit;
