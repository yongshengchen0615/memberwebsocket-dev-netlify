alter table public.calendar_items
  add column if not exists bonus_points_enabled boolean not null default false,
  add column if not exists bonus_points integer not null default 0;

alter table public.calendar_items
  drop constraint if exists calendar_items_bonus_points_check;

alter table public.calendar_items
  add constraint calendar_items_bonus_points_check
  check (bonus_points between 0 and 100);

create table if not exists public.scheduled_grant_messages (
  id uuid primary key default gen_random_uuid(),
  schedule_id text not null unique,
  request_id text not null unique,
  member_id uuid not null references public.members(id) on delete restrict,
  line_user_id text not null,
  scheduled_for timestamptz not null,
  message_text text not null check (char_length(message_text) between 1 and 5000),
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  last_error text not null default '',
  line_request_id text not null default '',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists scheduled_grant_messages_due_idx
  on public.scheduled_grant_messages (status, scheduled_for);

alter table public.scheduled_grant_messages enable row level security;
revoke all on table public.scheduled_grant_messages from anon, authenticated;
grant select, insert, update, delete on table public.scheduled_grant_messages to service_role;

create or replace function public.save_calendar_item_with_bonus(
  p_actor_line_user_id text,
  p_calendar_item jsonb,
  p_expected_updated_at text default ''
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_item jsonb := coalesce(p_calendar_item, '{}'::jsonb);
  v_type text := coalesce(v_item->>'itemType','');
  v_enabled boolean := coalesce((v_item->>'bonusPointsEnabled')::boolean,false);
  v_points integer := coalesce((v_item->>'bonusPoints')::integer,0);
  v_result jsonb;
  v_id text;
begin
  if v_type <> 'event' then
    v_enabled := false;
    v_points := 0;
  elsif v_enabled then
    if v_points < 1 or v_points > 100 then
      raise exception 'INVALID_EVENT_BONUS_POINTS';
    end if;
  else
    v_points := 0;
  end if;

  v_result := public.apply_calendar_batch(
    p_actor_line_user_id,
    jsonb_build_array(
      jsonb_build_object(
        'action','save',
        'calendarItem',v_item - 'bonusPointsEnabled' - 'bonusPoints',
        'expectedUpdatedAt',coalesce(p_expected_updated_at,'')
      )
    )
  );

  v_id := coalesce(v_result#>>'{0,calendarItemId}','');
  if v_id = '' then
    raise exception 'CALENDAR_ITEM_NOT_FOUND';
  end if;

  update public.calendar_items
  set bonus_points_enabled=v_enabled,
      bonus_points=v_points,
      updated_by=p_actor_line_user_id,
      updated_at=now()
  where calendar_item_id=v_id;

  return v_result;
end;
$function$;

revoke all on function public.save_calendar_item_with_bonus(text,jsonb,text) from public, anon, authenticated;
grant execute on function public.save_calendar_item_with_bonus(text,jsonb,text) to service_role;

create or replace function public.grant_member_benefits_with_event_bonus(
  p_actor_line_user_id text,
  p_member_line_user_id text,
  p_request_id text,
  p_points jsonb,
  p_service_minutes integer,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_member public.members%rowtype;
  v_item jsonb;
  v_card public.point_cards%rowtype;
  v_base_amount integer;
  v_effective_amount integer;
  v_now timestamptz := now();
  v_rows integer := 0;
  v_point_grant_count integer := 0;
  v_service_grant_applied boolean := false;
  v_current_minutes integer := 0;
  v_tier_key text := 'general';
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_bonus_total integer := 0;
  v_bonus_events jsonb := '[]'::jsonb;
  v_point_details jsonb := '[]'::jsonb;
  v_bonus_note text := '';
  v_point_count integer := 0;
  v_distinct_card_count integer := 0;
begin
  if length(coalesce(p_request_id,'')) < 16 or length(p_request_id) > 100 then
    raise exception 'INVALID_REQUEST_ID';
  end if;

  select * into v_member
  from public.members
  where line_user_id=p_member_line_user_id
  for update;

  if not found then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  if p_points is not null then
    if jsonb_typeof(p_points) <> 'array' then
      raise exception 'INVALID_POINTS';
    end if;
    v_point_count := jsonb_array_length(p_points);
    if v_point_count > 20 then
      raise exception 'INVALID_POINTS';
    end if;
    select count(distinct value->>'cardId') into v_distinct_card_count
    from jsonb_array_elements(p_points);
    if v_point_count <> v_distinct_card_count then
      raise exception 'DUPLICATE_POINT_CARD';
    end if;
  end if;

  select coalesce(sum(minutes),0)::integer into v_current_minutes
  from public.service_time_entries
  where member_id=v_member.id;

  select coalesce(tier_key,'general') into v_tier_key
  from public.membership_tier_settings
  where required_service_minutes <= v_current_minutes
  order by required_service_minutes desc
  limit 1;

  v_tier_key := coalesce(v_tier_key,'general');

  select
    coalesce(sum(bonus_points),0)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'calendarItemId',calendar_item_id,
          'title',title,
          'bonusPoints',bonus_points
        ) order by starts_on, created_at
      ),
      '[]'::jsonb
    )
  into v_bonus_total, v_bonus_events
  from public.calendar_items
  where item_type='event'
    and status='active'
    and bonus_points_enabled=true
    and bonus_points > 0
    and starts_on <= v_today
    and coalesce(ends_on,starts_on) >= v_today
    and (
      coalesce(cardinality(allowed_tier_keys),0)=0
      or v_tier_key = any(allowed_tier_keys)
    );

  if v_bonus_total > 0 then
    select '活動加贈：' || string_agg(
      coalesce(value->>'title','活動') || ' +' || coalesce(value->>'bonusPoints','0') || ' 點',
      '、'
    )
    into v_bonus_note
    from jsonb_array_elements(v_bonus_events);
  end if;

  if p_points is not null and jsonb_typeof(p_points)='array' then
    for v_item in select value from jsonb_array_elements(p_points)
    loop
      begin
        v_base_amount := coalesce((v_item->>'amount')::integer,0);
      exception when others then
        raise exception 'INVALID_POINT_AMOUNT';
      end;

      if v_base_amount < 1 or v_base_amount > 100 then
        raise exception 'INVALID_POINT_AMOUNT';
      end if;

      select * into v_card
      from public.point_cards
      where card_id=v_item->>'cardId'
        and status='active'
        and (expiry_mode='unlimited' or expires_on >= v_today)
      for update;

      if not found then
        raise exception 'POINT_CARD_NOT_AVAILABLE';
      end if;

      v_effective_amount := v_base_amount + v_bonus_total;

      insert into public.point_entries(
        entry_id,member_id,point_card_id,amount,note,created_by,request_id,entry_type,reference_type,reference_id
      )
      values(
        public.new_public_id('PE'),v_member.id,v_card.id,v_effective_amount,
        trim(concat_ws('；',nullif(coalesce(p_note,''),''),nullif(v_bonus_note,''))),
        p_actor_line_user_id,p_request_id,'grant',
        case when v_bonus_total > 0 then 'calendar_bonus' else null end,
        case when v_bonus_total > 0 then 'multiple' else null end
      )
      on conflict(request_id,member_id,point_card_id)
      where request_id is not null and request_id <> ''
      do nothing;

      get diagnostics v_rows = row_count;

      v_point_details := v_point_details || jsonb_build_array(
        jsonb_build_object(
          'cardId',v_card.card_id,
          'cardTitle',v_card.title,
          'baseAmount',v_base_amount,
          'bonusAmount',v_bonus_total,
          'effectiveAmount',v_effective_amount,
          'applied',v_rows > 0
        )
      );

      if v_rows > 0 then
        v_point_grant_count := v_point_grant_count + 1;

        insert into public.point_balances(member_id,point_card_id,stamps,updated_at)
        values(v_member.id,v_card.id,v_effective_amount,v_now)
        on conflict(member_id,point_card_id)
        do update
          set stamps=public.point_balances.stamps+excluded.stamps,
              updated_at=v_now;

        perform public.issue_eligible_point_tickets(v_member.id,v_card.id);
      end if;
    end loop;
  end if;

  if coalesce(p_service_minutes,0) > 0 then
    if p_service_minutes < 1 or p_service_minutes > 1440 then
      raise exception 'INVALID_SERVICE_MINUTES';
    end if;

    insert into public.service_time_entries(
      entry_id,member_id,minutes,note,created_by,request_id
    )
    values(
      public.new_public_id('SE'),v_member.id,p_service_minutes,coalesce(p_note,''),
      p_actor_line_user_id,p_request_id
    )
    on conflict(request_id,member_id)
    where request_id is not null and request_id <> ''
    do nothing;

    get diagnostics v_rows = row_count;
    v_service_grant_applied := v_rows > 0;
  end if;

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  )
  values(
    public.new_public_id('AUD'),p_actor_line_user_id,'admin','admin.member-grants.add',
    'member',p_member_line_user_id,'success',
    jsonb_build_object(
      'requestId',p_request_id,
      'requestedPointCount',coalesce(jsonb_array_length(p_points),0),
      'appliedPointCount',v_point_grant_count,
      'requestedServiceMinutes',coalesce(p_service_minutes,0),
      'serviceGrantApplied',v_service_grant_applied,
      'memberTierBeforeGrant',v_tier_key,
      'calendarBonusTotalPerCard',v_bonus_total,
      'calendarBonusEvents',v_bonus_events,
      'pointDetails',v_point_details,
      'applied',(v_point_grant_count > 0 or v_service_grant_applied)
    )
  );

  return jsonb_build_object(
    'memberId',v_member.id,
    'lineUserId',v_member.line_user_id,
    'pointGrantCount',v_point_grant_count,
    'serviceGrantApplied',v_service_grant_applied,
    'memberTierBeforeGrant',v_tier_key,
    'bonusTotalPerCard',v_bonus_total,
    'bonusEvents',v_bonus_events,
    'pointDetails',v_point_details,
    'applied',(v_point_grant_count > 0 or v_service_grant_applied)
  );
end;
$function$;

revoke all on function public.grant_member_benefits_with_event_bonus(text,text,text,jsonb,integer,text) from public, anon, authenticated;
grant execute on function public.grant_member_benefits_with_event_bonus(text,text,text,jsonb,integer,text) to service_role;

create or replace function public.claim_due_grant_messages(p_limit integer default 20)
returns setof public.scheduled_grant_messages
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.scheduled_grant_messages
  set status='pending',
      scheduled_for=now(),
      last_error=case when last_error='' then 'dispatcher_timeout' else last_error end,
      updated_at=now()
  where status='sending'
    and updated_at < now() - interval '10 minutes'
    and attempt_count < 3;

  update public.scheduled_grant_messages
  set status='failed',
      last_error=case when last_error='' then 'max_attempts_reached' else last_error end,
      updated_at=now()
  where status='sending'
    and updated_at < now() - interval '10 minutes'
    and attempt_count >= 3;

  return query
  with candidates as (
    select id
    from public.scheduled_grant_messages
    where status='pending'
      and scheduled_for <= now()
    order by scheduled_for, created_at
    for update skip locked
    limit greatest(1,least(coalesce(p_limit,20),50))
  )
  update public.scheduled_grant_messages s
  set status='sending',
      attempt_count=s.attempt_count+1,
      updated_at=now()
  from candidates c
  where s.id=c.id
  returning s.*;
end;
$function$;

revoke all on function public.claim_due_grant_messages(integer) from public, anon, authenticated;
grant execute on function public.claim_due_grant_messages(integer) to service_role;
