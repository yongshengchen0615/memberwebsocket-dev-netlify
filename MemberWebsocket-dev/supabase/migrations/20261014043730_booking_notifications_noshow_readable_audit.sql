begin;
alter table public.bookings drop constraint bookings_status_check;
alter table public.bookings add constraint bookings_status_check check(status in ('pending','confirmed','rejected','cancelled','completed','no_show'));
alter table public.bookings add column no_show_at timestamptz, add column no_show_by text;

create or replace function public.cancel_booking_benefit_selections_on_terminal_status()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status in ('cancelled','rejected','no_show') and old.status is distinct from new.status then
  update public.booking_benefit_selections set status='cancelled' where booking_id=new.id and status='pending';
 end if;
 return new;
end $$;

create function public.admin_mark_booking_no_show(p_actor text,p_booking_id uuid,p_expected_updated_at timestamptz,p_note text default '')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b public.bookings%rowtype;
begin
 perform 1 from public.admins where line_user_id=p_actor and role='admin' and status='active' for share;
 if not found then raise exception 'ADMIN_REQUIRED'; end if;
 select * into b from public.bookings where id=p_booking_id for update;
 if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
 if b.receipt_submission_id is not null or b.request_id like 'receipt-register:%' then raise exception 'BOOKING_NO_SHOW_NOT_ALLOWED'; end if;
 if b.status='no_show' then return jsonb_build_object('alreadyApplied',true); end if;
 if b.status<>'pending' then raise exception 'BOOKING_NO_SHOW_NOT_ALLOWED'; end if;
 if b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null then raise exception 'BOOKING_CANCELLATION_PENDING'; end if;
 if p_expected_updated_at is null or b.updated_at<>p_expected_updated_at then raise exception 'BOOKING_CONFLICT'; end if;
 if b.end_at is null or b.end_at>=(clock_timestamp() at time zone 'Asia/Taipei') then raise exception 'BOOKING_NO_SHOW_TOO_EARLY'; end if;
 if p_note is null or length(p_note)>500 then raise exception 'INVALID_ADMIN_NOTE'; end if;
 update public.bookings set status='no_show',no_show_at=clock_timestamp(),no_show_by=p_actor,admin_note=p_note where id=b.id;
 -- No settlement, point debit, ticket redemption or member LINE notification.
 insert into public.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
 values(p_actor,'admin','BOOKING_NO_SHOW','booking',b.id::text,'success',jsonb_build_object('previousStatus',b.status,'nextStatus','no_show'));
 return jsonb_build_object('alreadyApplied',false);
end $$;
revoke all on function public.admin_mark_booking_no_show(text,uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.admin_mark_booking_no_show(text,uuid,timestamptz,text) to service_role;

create function public.record_member_card_open(p_actor text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.members%rowtype; bucket bigint;
begin
 select * into m from public.members where line_user_id=p_actor and status='active' and membership_status='active';
 if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
 bucket:=floor(extract(epoch from clock_timestamp())/900);
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values('MCO-'||encode(extensions.digest(p_actor||':'||bucket::text,'sha256'),'hex'),p_actor,'member','MEMBER_CARD_OPEN','member',m.id::text,'success','{}') on conflict(audit_id) do nothing;
 return true;
end $$;
revoke all on function public.record_member_card_open(text) from public,anon,authenticated;
grant execute on function public.record_member_card_open(text) to service_role;

create function public.save_member_profile_audited(p_actor text,p_expected_updated_at timestamptz,p_fields jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.members%rowtype; fields jsonb;
begin
 select * into m from public.members where line_user_id=p_actor and status='active' and membership_status='active' for update;
 if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
 if p_fields is null or jsonb_typeof(p_fields)<>'object' or exists(select 1 from jsonb_object_keys(p_fields) k where k not in ('birthday','phone','surname','salutation')) then raise exception 'INVALID_PROFILE_FIELDS'; end if;
 if p_fields ? 'birthday' and (p_fields->>'birthday' is null or (p_fields->>'birthday')::date>(clock_timestamp() at time zone 'Asia/Taipei')::date) then raise exception 'INVALID_PROFILE_FIELDS'; end if;
 if p_fields ? 'phone' and coalesce(p_fields->>'phone','') !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'INVALID_PROFILE_FIELDS'; end if;
 if p_fields ? 'surname' and coalesce(length(btrim(p_fields->>'surname')),0) not between 1 and 40 then raise exception 'INVALID_PROFILE_FIELDS'; end if;
 if p_fields ? 'salutation' and coalesce(p_fields->>'salutation','') not in ('mr','ms') then raise exception 'INVALID_PROFILE_FIELDS'; end if;
 select coalesce(jsonb_agg(k order by k),'[]') into fields from jsonb_each_text(p_fields) x(k,v)
 where v is distinct from (to_jsonb(m)->>k);
 if jsonb_array_length(fields)=0 then return to_jsonb(m); end if;
 if p_expected_updated_at is null or m.updated_at<>p_expected_updated_at then raise exception 'PROFILE_CONFLICT'; end if;
 update public.members set birthday=case when p_fields ? 'birthday' then (p_fields->>'birthday')::date else birthday end,
 phone=case when p_fields ? 'phone' then p_fields->>'phone' else phone end,
 surname=case when p_fields ? 'surname' then btrim(p_fields->>'surname') else surname end,
 salutation=case when p_fields ? 'salutation' then p_fields->>'salutation' else salutation end,updated_at=clock_timestamp()
 where id=m.id returning * into m;
 insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
 values(public.new_public_id('AUD'),p_actor,'member','MEMBER_PROFILE_UPDATED','member',m.id::text,'success',jsonb_build_object('profileFields',fields));
 return to_jsonb(m);
end $$;
revoke all on function public.save_member_profile_audited(text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.save_member_profile_audited(text,timestamptz,jsonb) to service_role;

create function public.operation_audit_safe_detail(p_action text,p_type text,p_target text,p_meta jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare answer jsonb:='{}'; fields jsonb; t public.point_transfers%rowtype; v_title text;
begin
 if jsonb_typeof(p_meta)<>'object' then p_meta:='{}'; end if;
 if p_action in ('MEMBER_PROFILE_UPDATED','user.member.profile.save','admin.member.update','ADMIN_MEMBER_UPDATE') then
  select coalesce(jsonb_agg(v),'[]') into fields from jsonb_array_elements(case when jsonb_typeof(p_meta->'profileFields')='array' then p_meta->'profileFields' else '[]' end) v
  where v#>>'{}' in ('birthday','phone','surname','salutation','display_name','status','membership_status');
  answer:=answer||jsonb_build_object('profileFields',fields);
 end if;
 if p_action='user.pointcard.transfer' then
  select * into t from public.point_transfers where transfer_id=p_target;
  if found then
   answer:=answer||jsonb_build_object('amount',t.amount,'sender',(select left(member_code,3)||'…'||right(member_code,3) from public.members where id=t.sender_member_id),'receiver',(select left(member_code,3)||'…'||right(member_code,3) from public.members where id=t.receiver_member_id),'cardTitle',(select left(title,120) from public.point_cards where id=t.point_card_id));
  end if;
 end if;
 if p_action='BOOKING_BENEFITS_UPDATED' and jsonb_typeof(p_meta->'ticketTitles')='array' then
  select string_agg(left(value#>>'{}',100),'、') into v_title from jsonb_array_elements(p_meta->'ticketTitles') x(value) where jsonb_typeof(value)='string';
  if v_title is not null then answer:=answer||jsonb_build_object('ticketTitle',left(v_title,300)); end if;
 elsif p_type='booking' and p_action ~ '^(BOOKING_|SNAPSHOT_)' then
  select string_agg(distinct left(s.title_snapshot,100),'、') into v_title from public.booking_benefit_selections s where booking_id::text=p_target and benefit_kind in ('points','event');
  if v_title is not null then answer:=answer||jsonb_build_object('ticketTitle',left(v_title,300)); end if;
 end if;
 if p_type in ('point_ticket_batch','event_claim_batch') then
  if p_type='point_ticket_batch' then
   select string_agg(distinct left(ticket_title,100),'、') into v_title from public.point_tickets where ticket_id in
    (select value from jsonb_array_elements_text(case when jsonb_typeof(p_meta->'ticketIds')='array' then p_meta->'ticketIds' else '[]' end));
  else
   select string_agg(distinct left(ticket_title,100),'、') into v_title from public.event_ticket_claims where claim_id in
    (select value from jsonb_array_elements_text(case when jsonb_typeof(p_meta->'claimIds')='array' then p_meta->'claimIds' else '[]' end));
  end if;
  if v_title is not null then answer:=answer||jsonb_build_object('ticketTitle',left(v_title,300)); end if;
 end if;
 if p_action in ('SNAPSHOT_POINT_TICKET_CANCELLED','SNAPSHOT_EVENT_TICKET_CANCELLED') then
  select left(ticket_title,120) into v_title from public.point_tickets where ticket_id=p_meta->>'ticketId';
  if v_title is null then select left(ticket_title,120) into v_title from public.event_ticket_claims where claim_id=p_meta->>'ticketId'; end if;
  if v_title is not null then answer:=answer||jsonb_build_object('ticketTitle',v_title); end if;
 end if;
 if p_type in ('point_ticket','ticket','event_ticket_claim','event_claim') then
  select left(ticket_title,120) into v_title from public.point_tickets where ticket_id=p_target;
  if v_title is null then select left(ticket_title,120) into v_title from public.event_ticket_claims where claim_id=p_target; end if;
  if v_title is not null then answer:=answer||jsonb_build_object('ticketTitle',v_title); end if;
 end if;
 return answer;
end $$;
revoke all on function public.operation_audit_safe_detail(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.operation_audit_safe_detail(text,text,text,jsonb) to service_role;
create or replace function public.member_update_booking_benefits_request(
  p_line_user_id text,p_booking_id uuid,p_expected_updated_at timestamptz,
  p_request_id text,p_benefits jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  b public.bookings%rowtype;
  m public.members%rowtype;
  replay public.booking_benefit_change_requests%rowtype;
  normalized jsonb;
  answer jsonb;
  max_points int;
  max_events int;
begin
  if p_request_id is null or p_request_id !~ '^BSEL-[A-Za-z0-9-]{8,95}$'
    then raise exception 'INVALID_REQUEST_ID'; end if;
  if p_benefits is null or jsonb_typeof(p_benefits)<>'array'
    then raise exception 'INVALID_BOOKING_BENEFITS'; end if;
  if jsonb_array_length(p_benefits)>20 or exists(
    select 1 from jsonb_array_elements(p_benefits) v
    where jsonb_typeof(v)<>'object' or coalesce(v->>'kind','') not in ('points','event')
      or coalesce(length(v->>'id'),0) not between 1 and 160
  ) then raise exception 'INVALID_BOOKING_BENEFITS'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('kind',v->>'kind','id',v->>'id') order by v->>'kind',v->>'id'),'[]')
    into normalized from jsonb_array_elements(p_benefits) v;
  if (select count(*) from (select distinct v->>'kind',v->>'id' from jsonb_array_elements(normalized) v) x)
    <>jsonb_array_length(normalized) then raise exception 'INVALID_BOOKING_BENEFITS'; end if;

  -- Same booking -> member lock order as final completion. Identity is supplied by
  -- the authenticated Edge handler; browser roles cannot execute this RPC.
  select * into b from public.bookings where id=p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_OWNED'; end if;
  select * into m from public.members where id=b.member_id and line_user_id=p_line_user_id for update;
  if not found then raise exception 'BOOKING_NOT_OWNED'; end if;
  if m.status<>'active' or m.membership_status<>'active' then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  select * into replay from public.booking_benefit_change_requests
    where member_id=m.id and request_id=p_request_id;
  if found then
    if replay.booking_id<>p_booking_id or replay.selections<>normalized then raise exception 'REQUEST_ID_CONFLICT'; end if;
    return replay.result || jsonb_build_object('alreadyApplied',true);
  end if;
  if b.status not in ('pending','confirmed') or b.completed_at is not null or b.receipt_submission_id is not null
    then raise exception 'BOOKING_NOT_EDITABLE'; end if;
  if b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null
    then raise exception 'BOOKING_CANCELLATION_PENDING'; end if;
  if p_expected_updated_at is null or b.updated_at<>p_expected_updated_at
    then raise exception 'BOOKING_CONFLICT'; end if;
  -- Already redeemed benefits remain immutable; caller sends only pending intent.
  if exists(select 1 from jsonb_array_elements(normalized) v
    join public.booking_benefit_selections s on s.booking_id=b.id
      and s.benefit_kind=v->>'kind' and s.benefit_ref=v->>'id'
    where s.status in ('redeemed','applied')) then raise exception 'BOOKING_BENEFIT_ALREADY_USED'; end if;
  select max_tickets_per_redemption into max_points from public.point_card_settings where id=1;
  select max_tickets_per_day into max_events from public.event_ticket_settings where id=1;
  if coalesce(max_points,1)>0 and
    (select count(*) from jsonb_array_elements(normalized) v where v->>'kind'='points')+
    (select count(*) from public.booking_benefit_selections where booking_id=b.id and benefit_kind='points' and status='redeemed')>coalesce(max_points,1)
    then raise exception 'BOOKING_POINT_TICKET_LIMIT_EXCEEDED'; end if;
  if coalesce(max_events,1)>0 and
    (select count(*) from jsonb_array_elements(normalized) v where v->>'kind'='event')+
    (select count(*) from public.booking_benefit_selections where booking_id=b.id and benefit_kind='event' and status='redeemed')>coalesce(max_events,1)
    then raise exception 'BOOKING_EVENT_TICKET_LIMIT_EXCEEDED'; end if;
  if exists(select 1 from jsonb_array_elements(normalized) v
    where not public.booking_ticket_matches_services(b.id,m.id,v->>'kind',v->>'id'))
    then raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'; end if;
  perform public.replace_booking_benefit_selections_request(b.id,m.id,normalized ||
    coalesce((select jsonb_agg(jsonb_build_object('kind',benefit_kind,'id',benefit_ref))
      from public.booking_benefit_selections where booking_id=b.id and benefit_kind='calendar' and status='pending'),'[]'));
  -- Do not silently discard a stale/incompatible checkbox payload.
  if (select count(*) from public.booking_benefit_selections where booking_id=b.id
      and status='pending' and benefit_kind in ('points','event'))<>jsonb_array_length(normalized)
    then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
  update public.bookings set updated_at=clock_timestamp() where id=b.id returning * into b;
  answer:=jsonb_build_object('bookingId',b.id,'updatedAt',b.updated_at,'requestId',p_request_id,'alreadyApplied',false);
  insert into public.booking_benefit_change_requests(member_id,request_id,booking_id,selections,result)
    values(m.id,p_request_id,b.id,normalized,answer);
  -- Audit failure rolls back the selection change and replay entry together.
  insert into public.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
    values(p_line_user_id,'member','BOOKING_BENEFITS_UPDATED','booking',b.id::text,'success',
      jsonb_build_object('requestId',p_request_id,'selectedCount',jsonb_array_length(normalized),'ticketTitles',coalesce((select jsonb_agg(left(title_snapshot,100) order by benefit_kind,benefit_ref) from public.booking_benefit_selections where booking_id=b.id and status='pending' and benefit_kind in ('points','event')),'[]')));
  return answer;
end $$;
revoke all on function public.member_update_booking_benefits_request(text,uuid,timestamptz,text,jsonb) from public,anon,authenticated;
grant execute on function public.member_update_booking_benefits_request(text,uuid,timestamptz,text,jsonb) to service_role;

create or replace function public.admin_query_operation_audit(
  p_actor text,p_from timestamptz,p_to timestamptz,p_member_code text default '',
  p_action text default '',p_result text default '',p_before_time timestamptz default null,
  p_before_id text default '',p_limit int default 50,p_request_id text default ''
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare answer jsonb; member_line text; member_uuid uuid;
begin
  if not exists(select 1 from public.admins where line_user_id=p_actor and role='admin' and status='active')
    then raise exception 'ADMIN_REQUIRED'; end if;
  if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '366 days'
    or p_limit not between 1 and 50 or p_result not in ('','success','failed')
    or length(p_action)>80 or length(p_member_code)>40
    or p_request_id !~ '^AUDQ-[A-Za-z0-9-]{8,95}$'
    then raise exception 'INVALID_AUDIT_QUERY'; end if;
  if p_member_code<>'' then
    select id,line_user_id into member_uuid,member_line from public.members where member_code=upper(p_member_code);
  end if;
  with events as (
    select 'audit:'||a.id::text event_id,a.actor_line_user_id actor,a.actor_role,a.action,a.target_type,a.target_id,a.result,a.detail metadata,a.created_at
    from public.audit_logs a
    where a.created_at>=p_from and a.created_at<p_to and
      (a.action ~ '^admin\.' or a.action ~ '^user\.(pointcard|event)\.(ticket|tickets)\.'
       or a.action ~ '^user\.booking\.receipt\.' or a.action ~ '^(LOGIN_|MEMBERSHIP_|MEMBER_|TICKET_|SNAPSHOT_|SETTINGS_|ADMIN_)'
       or a.action in ('AUDIT_QUERY_VIEWED','user.member.profile.save','user.pointcard.transfer'))
    union all
    select 'booking:'||a.id::text,a.actor_line_user_id,a.actor_role,a.action,a.target_type,a.target_id,a.result,a.metadata,a.created_at
    from public.booking_audit_events a
    where a.created_at>=p_from and a.created_at<p_to and a.action ~ '^(BOOKING_|SNAPSHOT_|TICKET_)'
  ), page as (
    select * from events e
    where (p_action='' or e.action=p_action) and (p_result='' or e.result=p_result)
      and (p_before_time is null or (e.created_at,e.event_id)<(p_before_time,p_before_id))
      and (p_member_code='' or e.actor=member_line or e.target_id in (member_line,member_uuid::text)
        or exists(select 1 from public.bookings b where b.id::text=e.target_id and b.member_id=member_uuid)
        or exists(select 1 from public.point_transfers t where t.transfer_id=e.target_id and member_uuid in (t.sender_member_id,t.receiver_member_id)))
    order by created_at desc,event_id desc limit p_limit+1
  ), safe as (
    select created_at,event_id,jsonb_build_object('id',event_id,'actorRole',actor_role,
      'actorLabel',coalesce((select left(member_code,3)||'…'||right(member_code,3) from public.members where line_user_id=actor),''),
      'actor',case when actor is null or actor='' then 'system' else left(actor,5)||'…'||right(actor,3) end,
      'action',action,'targetType',target_type,
      'target',case when target_type in ('member','admin') or target_id ~ '^U[0-9a-f]{32}$'
        then left(target_id,5)||'…'||right(target_id,3) else left(target_id,100) end,
      'result',result,'createdAt',created_at,
      'detail',public.operation_audit_safe_detail(action,target_type,target_id,metadata) || coalesce((select jsonb_object_agg(k,v) from jsonb_each(case when jsonb_typeof(metadata)='object' then metadata else '{}'::jsonb end) x(k,v)
        where k in ('requestId','selectedCount','previousStatus','nextStatus','ticketCount','serviceMinutes','errorCode','clientType')
          and jsonb_typeof(v) in ('string','number','boolean') and length(v::text)<=120),'{}')) item
    from page
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(item order by created_at desc,event_id desc)
      from (select * from safe order by created_at desc,event_id desc limit p_limit) s),'[]'),
      'hasMore',(select count(*)>p_limit from safe)) into answer;
  -- Stable request id makes a retried read's access audit idempotent. Fail closed.
  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
    values('AUDQ-'||encode(extensions.digest(p_actor||':'||p_request_id,'sha256'),'hex'),p_actor,'admin',
      'AUDIT_QUERY_VIEWED','audit_query',p_request_id,'success',jsonb_build_object('selectedCount',jsonb_array_length(answer->'items')))
    on conflict(audit_id) do nothing;
  return answer;
end $$;
revoke all on function public.admin_query_operation_audit(text,timestamptz,timestamptz,text,text,text,timestamptz,text,int,text) from public,anon,authenticated;
grant execute on function public.admin_query_operation_audit(text,timestamptz,timestamptz,text,text,text,timestamptz,text,int,text) to service_role;

commit;
