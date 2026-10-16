-- Settings copies, explicit friendship consent and delegated service attribution.
alter table public.event_ticket_settings add column visibility_policy text not null default 'eligible_only'
  check (visibility_policy in ('eligible_only','higher_preview'));
alter table public.bookings add column service_recipient_member_id uuid references public.members(id) on delete restrict;
alter table public.bookings add constraint bookings_single_friend_recipient check(service_recipient_member_id is null or party_size=1);
create index bookings_service_recipient_idx on public.bookings(service_recipient_member_id) where service_recipient_member_id is not null;
create table public.member_friendships (
 id uuid primary key default gen_random_uuid(),
 member_a uuid not null references public.members(id) on delete cascade,
 member_b uuid not null references public.members(id) on delete cascade,
 requested_by uuid not null references public.members(id) on delete cascade,
 status text not null check(status in ('pending','accepted','removed','blocked')),
 updated_at timestamptz not null default now(),
 unique(member_a,member_b), check(member_a < member_b), check(requested_by in(member_a,member_b))
);
create index member_friendships_b_status_idx on public.member_friendships(member_b,status);
create table public.friend_booking_rewards (
 booking_id uuid primary key references public.bookings(id) on delete cascade,
 actor_member_id uuid not null references public.members(id) on delete restrict,
 recipient_member_id uuid not null references public.members(id) on delete restrict,
 service_minutes integer not null check(service_minutes>=0),
 reward_details jsonb not null default '[]', created_at timestamptz not null default now()
);
alter table public.member_friendships enable row level security;
alter table public.friend_booking_rewards enable row level security;
revoke all on public.member_friendships,public.friend_booking_rewards from public,anon,authenticated;
grant all on public.member_friendships,public.friend_booking_rewards to service_role;

create function public.member_friend_action(p_actor text,p_operation text,p_code text default '')
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 m public.members%rowtype; f public.members%rowtype; relation public.member_friendships%rowtype;
 friends jsonb; received jsonb;
begin
 select * into m from public.members where line_user_id=p_actor and status='active' and membership_status='active';
 if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
 if p_operation='list' then
  select coalesce(jsonb_agg(jsonb_build_object('memberCode',o.member_code,'displayName',left(o.display_name,1)||'○',
    'status',r.status,'incoming',r.requested_by<>m.id) order by r.updated_at desc),'[]') into friends
  from public.member_friendships r join public.members o on o.id=case when r.member_a=m.id then r.member_b else r.member_a end
  where m.id in(r.member_a,r.member_b) and o.status='active' and o.membership_status='active'
    and (r.status in('pending','accepted') or (r.status='blocked' and r.requested_by=m.id));
  select coalesce(jsonb_agg(x.summary order by x.booking_date desc),'[]') into received from (
    select b.booking_date,jsonb_build_object('bookingDate',b.booking_date,'startTime',left(b.start_time::text,5),
      'serviceTitle',(select string_agg(i.service_title,'、' order by i.created_at) from public.booking_items i where i.booking_id=b.id and i.service_id<>'00000000-0000-4000-8000-000000000010'::uuid),
      'statusLabel',case b.status when 'pending' then '待確認' when 'confirmed' then '已確認' when 'completed' then '已完成' when 'cancelled' then '已取消' else '未成立' end) summary
    from public.bookings b where b.service_recipient_member_id=m.id order by b.booking_date desc limit 20
  ) x;
  return jsonb_build_object('friends',friends,'receivedBookings',received);
 end if;
 select * into f from public.members where (upper(member_code)=upper(btrim(p_code)) or upper(invite_code)=upper(btrim(p_code)))
   and status='active' and membership_status='active' and is_test_account=m.is_test_account;
 if not found then raise exception 'FRIEND_NOT_FOUND'; end if;
 if f.id=m.id then raise exception 'SELF_FRIEND_NOT_ALLOWED'; end if;
 if p_operation='lookup' then return jsonb_build_object('memberCode',f.member_code,'displayName',left(f.display_name,1)||'○'); end if;
 perform pg_advisory_xact_lock(hashtextextended('friend:'||least(m.id,f.id)::text||':'||greatest(m.id,f.id)::text,0));
 select * into relation from public.member_friendships where member_a=least(m.id,f.id) and member_b=greatest(m.id,f.id) for update;
 if relation.status='blocked' and relation.requested_by<>m.id then raise exception 'FRIEND_BLOCKED'; end if;
 if p_operation='request' then
  if relation.status='blocked' then raise exception 'FRIEND_BLOCKED'; end if;
  if relation.status in('pending','accepted') then return jsonb_build_object('status',relation.status,'alreadyApplied',true); end if;
  insert into public.member_friendships(member_a,member_b,requested_by,status) values(least(m.id,f.id),greatest(m.id,f.id),m.id,'pending')
   on conflict(member_a,member_b) do update set requested_by=m.id,status='pending',updated_at=now();
 elsif p_operation='accept' then
  if relation.status='accepted' then return jsonb_build_object('status','accepted','alreadyApplied',true); end if;
  if relation.status is distinct from 'pending' or relation.requested_by=m.id then raise exception 'FRIEND_ACCEPT_DENIED'; end if;
  update public.member_friendships set status='accepted',updated_at=now() where id=relation.id;
 elsif p_operation in('remove','block') then
  if relation.id is null then raise exception 'FRIEND_NOT_FOUND'; end if;
  update public.member_friendships set status=case when p_operation='block' then 'blocked' else 'removed' end,
    requested_by=case when p_operation='block' then m.id else requested_by end,updated_at=now() where id=relation.id;
 else raise exception 'INVALID_FRIEND_OPERATION'; end if;
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values(public.new_public_id('AUD'),p_actor,'member','FRIEND_'||upper(p_operation),'member',f.id::text,'success',jsonb_build_object('memberCode',f.member_code));
 perform public.emit_realtime_invalidation(array['member','booking'],'friend.changed');
 return jsonb_build_object('status',case p_operation when 'request' then 'pending' when 'accept' then 'accepted' when 'block' then 'blocked' else 'removed' end);
end $$;

create function public.copy_admin_settings(p_actor text,p_kind text,p_source text,p_title text,p_request_id text)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
 v_key text:='settings-copy:'||p_actor||':'||p_request_id;
 v_hash text:=encode(extensions.digest(jsonb_build_array(p_kind,p_source,btrim(p_title))::text,'sha256'),'hex');
 previous public.idempotency_results%rowtype; source jsonb; copied jsonb; child jsonb; reward record;
 new_id uuid:=gen_random_uuid(); new_public text; child_id uuid; result jsonb;
begin
 if not exists(select 1 from public.admins where line_user_id=p_actor and status='active' and role='admin') then raise exception 'ADMIN_REQUIRED'; end if;
 if p_request_id !~ '^COPY-[A-Za-z0-9-]{8,100}$' or char_length(btrim(p_title)) not between 1 and 100 then raise exception 'INVALID_COPY_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_key,0));
 select * into previous from public.idempotency_results where request_key=v_key;
 if found then
  if previous.request_hash<>v_hash then raise exception 'REQUEST_ID_CONFLICT'; end if;
  return previous.result;
 end if;
 if p_kind='card' then
  select to_jsonb(c) into source from public.point_cards c where card_id=p_source for share;
  new_public:=public.new_public_id('PC');
 elsif p_kind='ticket' then
  select to_jsonb(c) into source from public.ticket_templates c where ticket_template_id=p_source for share;
  new_public:=public.new_public_id('TT');
 elsif p_kind='event' then
  select to_jsonb(c) into source from public.event_tickets c where event_ticket_id=p_source and deleted_at is null and fixed_ticket_template_id is null and referral_source_event_ticket_id is null for share;
  new_public:=public.new_public_id('EV');
 elsif p_kind='fixed' then
  select to_jsonb(c) into source from public.fixed_ticket_templates c where fixed_ticket_id=p_source and deleted_at is null for share;
  new_public:=public.new_public_id('FT');
 else raise exception 'INVALID_COPY_KIND'; end if;
 if source is null then raise exception 'COPY_SOURCE_NOT_FOUND'; end if;
 copied:=source||jsonb_build_object('id',new_id,'title',btrim(p_title),'status','draft','created_by',p_actor,'updated_by',p_actor,'created_at',now(),'updated_at',now());
 if p_kind='card' then
  copied:=copied||jsonb_build_object('card_id',new_public);
  insert into public.point_cards select (jsonb_populate_record(null::public.point_cards,copied)).*;
  for reward in select * from public.point_card_rewards where point_card_id=(source->>'id')::uuid order by threshold_stamps for share loop
   select to_jsonb(t) into child from public.ticket_templates t where id=reward.ticket_template_id for share;
   child_id:=gen_random_uuid();
   child:=child||jsonb_build_object('id',child_id,'ticket_template_id',public.new_public_id('TT'),'status','draft','created_by',p_actor,'updated_by',p_actor,'created_at',now(),'updated_at',now());
   insert into public.ticket_templates select (jsonb_populate_record(null::public.ticket_templates,child)).*;
   insert into public.point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id,required_service_ids,required_service_match_mode)
    values(public.new_public_id('RW'),new_id,reward.threshold_stamps,child_id,reward.required_service_ids,reward.required_service_match_mode);
  end loop;
 elsif p_kind='ticket' then
  insert into public.ticket_templates select (jsonb_populate_record(null::public.ticket_templates,copied||jsonb_build_object('ticket_template_id',new_public))).*;
 elsif p_kind='event' then
  insert into public.event_tickets select (jsonb_populate_record(null::public.event_tickets,copied||jsonb_build_object('event_ticket_id',new_public,'deleted_at',null,'fixed_ticket_template_id',null,'fixed_cycle_key',null,'referral_source_event_ticket_id',null))).*;
 else
  insert into public.fixed_ticket_templates select (jsonb_populate_record(null::public.fixed_ticket_templates,copied||jsonb_build_object('fixed_ticket_id',new_public,'deleted_at',null,'notify_line',false,'calendar_enabled',false))).*;
 end if;
 result:=jsonb_build_object('kind',p_kind,'publicId',new_public,'status','draft');
 insert into public.idempotency_results(request_key,action,actor_line_user_id,request_hash,result) values(v_key,'admin.settings.copy',p_actor,v_hash,result);
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values(public.new_public_id('AUD'),p_actor,'admin','SETTINGS_COPIED',p_kind,new_public,'success',jsonb_build_object('sourceId',p_source,'newId',new_public));
 return result;
end $$;

create function public.create_friend_booking_request(p_actor text,p_friend_code text,p_request_id text,p_booking_date date,p_start_time time,
 p_participants jsonb,p_member_note text,p_contact_source text,p_contact_surname text,p_contact_salutation text,p_contact_phone text,p_benefits jsonb)
returns public.bookings language plpgsql security invoker set search_path=public,pg_temp as $$
declare m public.members%rowtype; f public.members%rowtype; b public.bookings%rowtype;
 v_key text:='friend-booking-create:'||p_actor||':'||p_request_id;
 v_hash text:=encode(extensions.digest(jsonb_build_array(p_friend_code,p_booking_date,p_start_time,p_participants,p_member_note,p_contact_source,p_contact_surname,p_contact_salutation,p_contact_phone,p_benefits)::text,'sha256'),'hex');
 previous public.idempotency_results%rowtype;
begin
 select * into m from public.members where line_user_id=p_actor and status='active' and membership_status='active';
 if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
 select * into f from public.members where upper(member_code)=upper(btrim(p_friend_code)) and status='active' and membership_status='active' and is_test_account=m.is_test_account;
 if not found or f.id=m.id then raise exception 'FRIEND_NOT_FOUND'; end if;
 if jsonb_typeof(p_participants) is distinct from 'array' or jsonb_array_length(p_participants)<>1 then raise exception 'FRIEND_SINGLE_RECIPIENT_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('friend:'||least(m.id,f.id)::text||':'||greatest(m.id,f.id)::text,0));
 if not exists(select 1 from public.member_friendships where member_a=least(m.id,f.id) and member_b=greatest(m.id,f.id) and status='accepted') then raise exception 'FRIEND_ACCEPTED_REQUIRED'; end if;
 select * into b from public.bookings where request_id=p_request_id for update;
 if found and (b.member_id<>m.id or b.service_recipient_member_id is distinct from f.id) then raise exception 'REQUEST_ID_CONFLICT'; end if;
 perform 1 from public.members where id in(m.id,f.id) order by id for update;
 select * into previous from public.idempotency_results where request_key=v_key;
 if found then
  if previous.request_hash<>v_hash then raise exception 'REQUEST_ID_CONFLICT'; end if;
  return b;
 end if;
 b:=public.create_group_booking_with_benefits_request_v2(p_request_id,m.id,p_booking_date,p_start_time,p_participants,p_member_note,p_contact_source,p_contact_surname,p_contact_salutation,p_contact_phone,p_benefits);
 update public.bookings set service_recipient_member_id=f.id where id=b.id returning * into b;
 insert into public.idempotency_results(request_key,action,actor_line_user_id,request_hash,result) values(v_key,'friend.booking.create',p_actor,v_hash,jsonb_build_object('bookingId',b.id));
 return b;
end $$;

revoke all on function public.member_friend_action(text,text,text),public.copy_admin_settings(text,text,text,text,text),public.create_friend_booking_request(text,text,text,date,time,jsonb,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.member_friend_action(text,text,text),public.copy_admin_settings(text,text,text,text,text),public.create_friend_booking_request(text,text,text,date,time,jsonb,text,text,text,text,text,jsonb) to service_role;

CREATE OR REPLACE FUNCTION public.complete_booking_with_rewards_request(p_booking_id uuid, p_expected_updated_at timestamp with time zone, p_actor text, p_admin_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_booking public.bookings%rowtype;
  v_primary_technician_id uuid;
  v_actor_member_id uuid;
  v_recipient_member_id uuid;
  v_delegate_details jsonb := '[]'::jsonb;
  v_request_id text := 'booking-complete:' || p_booking_id::text;
  v_service_minutes integer := 0;
  v_reward_details jsonb := '[]'::jsonb;
  v_reward record;
  v_card public.point_cards%rowtype;
  v_rows integer := 0;
  v_now timestamptz := now();
begin
  select * into v_booking
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;

  if p_expected_updated_at is null or v_booking.updated_at <> p_expected_updated_at then
    raise exception 'BOOKING_CONFLICT';
  end if;

  if v_booking.cancellation_requested_at is not null
     and v_booking.cancellation_reviewed_at is null then
    raise exception 'BOOKING_CANCELLATION_PENDING';
  end if;

  if v_booking.status <> 'confirmed' then
    raise exception 'INVALID_BOOKING_TRANSITION';
  end if;

  if exists (
    select 1
    from public.booking_completion_settlements
    where booking_id = p_booking_id
  ) then
    raise exception 'BOOKING_COMPLETION_ALREADY_SETTLED';
  end if;

  v_actor_member_id := v_booking.member_id;
  v_recipient_member_id := coalesce(v_booking.service_recipient_member_id,v_actor_member_id);
  perform 1 from public.members where id in(v_actor_member_id,v_recipient_member_id) order by id for update;
  if not exists(select 1 from public.members where id=v_recipient_member_id and status='active' and membership_status='active') then
    raise exception 'SERVICE_RECIPIENT_UNAVAILABLE';
  end if;
  -- Keep the persisted booking owner and benefit ownership unchanged. Existing
  -- normal reward calculations below operate on the actual service recipient.
  v_booking.member_id := v_recipient_member_id;

  select primary_technician_id
    into v_primary_technician_id
  from public.booking_settings
  where id = 1;

  -- Completion of an existing booking is never blocked by a later setting change.
  -- The independent primary-technician-only reward policy still selects matching items.
  with eligible_items as (
    select
      bpi.service_id,
      bpi.unit_duration_minutes,
      greatest(coalesce(bpi.quantity, 1), 1)::integer as quantity,
      coalesce(
        nullif(btrim(coalesce(bi.service_type, '')), ''),
        nullif(btrim(coalesce(bs.service_type, '')), '')
      ) as service_type,
      coalesce(bi.counts_toward_membership, bs.counts_toward_membership, true) as counts_toward_membership
    from public.booking_participants bp
    join public.booking_participant_items bpi
      on bpi.participant_id = bp.id
    left join public.booking_items bi
      on bi.booking_id = bp.booking_id
     and bi.service_id = bpi.service_id
    left join public.booking_services bs
      on bs.id = bpi.service_id
    where bp.booking_id = p_booking_id
      and bp.technician_id = v_primary_technician_id
      and bpi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid
  )
  select coalesce(sum(ei.unit_duration_minutes * ei.quantity), 0)::integer
    into v_service_minutes
  from eligible_items ei
  where ei.counts_toward_membership = true;

  for v_reward in
    with eligible_items as (
      select
        bpi.service_id,
        bpi.unit_duration_minutes,
        greatest(coalesce(bpi.quantity, 1), 1)::integer as quantity,
        coalesce(
          nullif(btrim(coalesce(bi.service_type, '')), ''),
          nullif(btrim(coalesce(bs.service_type, '')), '')
        ) as service_type,
        coalesce(bi.counts_toward_membership, bs.counts_toward_membership, true) as counts_toward_membership
      from public.booking_participants bp
      join public.booking_participant_items bpi
        on bpi.participant_id = bp.id
      left join public.booking_items bi
        on bi.booking_id = bp.booking_id
       and bi.service_id = bpi.service_id
      left join public.booking_services bs
        on bs.id = bpi.service_id
      where bp.booking_id = p_booking_id
        and bp.technician_id = v_primary_technician_id
        and bpi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid
    ),
    type_minutes as (
      select
        lower(btrim(ei.service_type)) as type_key,
        sum(ei.unit_duration_minutes * ei.quantity)::integer as service_minutes
      from eligible_items ei
      where ei.counts_toward_membership = true
        and nullif(btrim(coalesce(ei.service_type, '')), '') is not null
      group by lower(btrim(ei.service_type))
    )
    select
      t.id as service_type_id,
      t.name as service_type_name,
      tm.service_minutes,
      r.minutes_per_point,
      r.point_card_id,
      floor(tm.service_minutes::numeric / r.minutes_per_point)::integer as points
    from type_minutes tm
    join public.booking_service_types t
      on lower(btrim(t.name)) = tm.type_key
    join public.booking_service_type_rewards r
      on r.service_type_id = t.id
    where floor(tm.service_minutes::numeric / r.minutes_per_point)::integer > 0
    order by t.sort_order, t.created_at
  loop
    select * into v_card
    from public.point_cards
    where id = v_reward.point_card_id
    for update;

    if not found
       or v_card.status <> 'active'
       or (v_card.expiry_mode <> 'unlimited'
           and (v_card.expires_on is null
                or v_card.expires_on < (clock_timestamp() at time zone 'Asia/Taipei')::date)) then
      raise exception 'BOOKING_REWARD_POINT_CARD_UNAVAILABLE';
    end if;

    v_reward_details := v_reward_details || jsonb_build_array(
      jsonb_build_object(
        'serviceTypeId', v_reward.service_type_id,
        'serviceTypeName', v_reward.service_type_name,
        'serviceMinutes', v_reward.service_minutes,
        'minutesPerPoint', v_reward.minutes_per_point,
        'pointCardId', v_card.id,
        'pointCardPublicId', v_card.card_id,
        'pointCardTitle', v_card.title,
        'points', v_reward.points
      )
    );
  end loop;

  if v_service_minutes > 0 then
    insert into public.service_time_entries(
      entry_id, member_id, minutes, note, created_by, request_id
    )
    values (
      public.new_public_id('SE'),
      v_booking.member_id,
      v_service_minutes,
      '預約完成自動加入服務時間（僅主要技師項目）',
      p_actor,
      v_request_id
    )
    on conflict (request_id, member_id)
      where request_id is not null and request_id <> ''
    do nothing;

    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'BOOKING_COMPLETION_SERVICE_TIME_CONFLICT';
    end if;
  end if;

  for v_reward in
    with eligible_items as (
      select
        bpi.service_id,
        bpi.unit_duration_minutes,
        greatest(coalesce(bpi.quantity, 1), 1)::integer as quantity,
        coalesce(
          nullif(btrim(coalesce(bi.service_type, '')), ''),
          nullif(btrim(coalesce(bs.service_type, '')), '')
        ) as service_type,
        coalesce(bi.counts_toward_membership, bs.counts_toward_membership, true) as counts_toward_membership
      from public.booking_participants bp
      join public.booking_participant_items bpi
        on bpi.participant_id = bp.id
      left join public.booking_items bi
        on bi.booking_id = bp.booking_id
       and bi.service_id = bpi.service_id
      left join public.booking_services bs
        on bs.id = bpi.service_id
      where bp.booking_id = p_booking_id
        and bp.technician_id = v_primary_technician_id
        and bpi.service_id <> '00000000-0000-4000-8000-000000000010'::uuid
    ),
    type_minutes as (
      select
        lower(btrim(ei.service_type)) as type_key,
        sum(ei.unit_duration_minutes * ei.quantity)::integer as service_minutes
      from eligible_items ei
      where ei.counts_toward_membership = true
        and nullif(btrim(coalesce(ei.service_type, '')), '') is not null
      group by lower(btrim(ei.service_type))
    ),
    per_type as (
      select
        r.point_card_id,
        floor(tm.service_minutes::numeric / r.minutes_per_point)::integer as points
      from type_minutes tm
      join public.booking_service_types t
        on lower(btrim(t.name)) = tm.type_key
      join public.booking_service_type_rewards r
        on r.service_type_id = t.id
    )
    select point_card_id, sum(points)::integer as points
    from per_type
    where points > 0
    group by point_card_id
  loop
    insert into public.point_entries(
      entry_id, member_id, point_card_id, amount, note, created_by,
      request_id, entry_type, reference_type, reference_id
    )
    values (
      public.new_public_id('PE'),
      v_booking.member_id,
      v_reward.point_card_id,
      v_reward.points,
      '預約完成自動集點（僅主要技師項目）',
      p_actor,
      v_request_id,
      'grant',
      'booking',
      p_booking_id::text
    )
    on conflict (request_id, member_id, point_card_id)
      where request_id is not null and request_id <> ''
    do nothing;

    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'BOOKING_COMPLETION_POINT_CONFLICT';
    end if;

    insert into public.point_balances(member_id, point_card_id, stamps, updated_at)
    values (v_booking.member_id, v_reward.point_card_id, v_reward.points, v_now)
    on conflict (member_id, point_card_id)
    do update
      set stamps = public.point_balances.stamps + excluded.stamps,
          updated_at = v_now;

    perform public.issue_eligible_point_tickets(v_booking.member_id, v_reward.point_card_id);
  end loop;

  if v_actor_member_id <> v_recipient_member_id then
    -- The existing ledger stores whole minutes; half minutes round down.
    if v_service_minutes / 2 > 0 then
      insert into public.service_time_entries(entry_id,member_id,minutes,note,created_by,request_id)
      values(public.new_public_id('SE'),v_actor_member_id,v_service_minutes/2,'代好友預約完成獎勵',p_actor,'friend-booking:'||p_booking_id::text);
    end if;
    for v_reward in
      select r.point_card_id,count(distinct t.id)::integer as points
      from public.booking_participants bp
      join public.booking_participant_items bpi on bpi.participant_id=bp.id
      join public.booking_items bi on bi.booking_id=bp.booking_id and bi.service_id=bpi.service_id
      join public.booking_service_types t on lower(btrim(t.name))=lower(btrim(bi.service_type))
      join public.booking_service_type_rewards r on r.service_type_id=t.id
      where bp.booking_id=p_booking_id and bp.technician_id=v_primary_technician_id
        and bpi.service_id<>'00000000-0000-4000-8000-000000000010'::uuid
        and bi.counts_toward_membership and bpi.unit_duration_minutes>0
      group by r.point_card_id
    loop
      select * into v_card from public.point_cards where id=v_reward.point_card_id for update;
      if not found or v_card.status<>'active' or (v_card.expiry_mode<>'unlimited' and (v_card.expires_on is null or v_card.expires_on<(clock_timestamp() at time zone 'Asia/Taipei')::date)) then
        raise exception 'BOOKING_REWARD_POINT_CARD_UNAVAILABLE';
      end if;
      insert into public.point_entries(entry_id,member_id,point_card_id,amount,note,created_by,request_id,entry_type,reference_type,reference_id)
      values(public.new_public_id('PE'),v_actor_member_id,v_card.id,v_reward.points,'代好友預約完成獎勵（每種服務 1 點）',p_actor,'friend-booking:'||p_booking_id::text,'grant','booking',p_booking_id::text);
      insert into public.point_balances(member_id,point_card_id,stamps,updated_at) values(v_actor_member_id,v_card.id,v_reward.points,v_now)
      on conflict(member_id,point_card_id) do update set stamps=public.point_balances.stamps+excluded.stamps,updated_at=v_now;
      perform public.issue_eligible_point_tickets(v_actor_member_id,v_card.id);
      v_delegate_details:=v_delegate_details||jsonb_build_array(jsonb_build_object('pointCardId',v_card.id,'pointCardTitle',v_card.title,'points',v_reward.points));
    end loop;
    insert into public.friend_booking_rewards(booking_id,actor_member_id,recipient_member_id,service_minutes,reward_details)
    values(p_booking_id,v_actor_member_id,v_recipient_member_id,v_service_minutes/2,v_delegate_details);
    insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
    values(public.new_public_id('AUD'),p_actor,'admin','FRIEND_BOOKING_SETTLED','booking',p_booking_id::text,'success',jsonb_build_object('actorMemberId',v_actor_member_id,'recipientMemberId',v_recipient_member_id,'minutes',v_service_minutes/2,'rewards',v_delegate_details));
  end if;

  insert into public.booking_completion_settlements(
    booking_id, member_id, service_minutes, reward_details, completed_by, created_at
  )
  values (
    p_booking_id,
    v_booking.member_id,
    v_service_minutes,
    v_reward_details,
    p_actor,
    v_now
  );

  update public.bookings
  set status = 'completed',
      admin_note = left(coalesce(p_admin_note, ''), 500),
      completed_by = p_actor,
      completed_at = v_now
  where id = p_booking_id
    and status = 'confirmed'
    and updated_at = p_expected_updated_at;

  if not found then
    raise exception 'BOOKING_CONFLICT';
  end if;

  return jsonb_build_object(
    'bookingId', p_booking_id,
    'primaryTechnicianId', v_primary_technician_id,
    'serviceMinutes', v_service_minutes,
    'serviceRecipientMemberId',v_recipient_member_id,
    'friendRewardMinutes',case when v_actor_member_id<>v_recipient_member_id then v_service_minutes/2 else 0 end,
    'friendRewards',v_delegate_details,
    'rewards', v_reward_details
  );
end;
$function$
;

create index friend_booking_rewards_actor_idx on public.friend_booking_rewards(actor_member_id);
create index friend_booking_rewards_recipient_idx on public.friend_booking_rewards(recipient_member_id);
create index member_friendships_requester_idx on public.member_friendships(requested_by);
notify pgrst, 'reload schema';
