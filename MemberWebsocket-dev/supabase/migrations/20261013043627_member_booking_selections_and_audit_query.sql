begin;

-- A reservation records intent. Only the existing completion transaction spends rights.
create table public.booking_benefit_change_requests (
  member_id uuid not null references public.members(id) on delete cascade,
  request_id text not null check (request_id ~ '^BSEL-[A-Za-z0-9-]{8,95}$'),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  selections jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(member_id,request_id)
);
alter table public.booking_benefit_change_requests enable row level security;
revoke all on public.booking_benefit_change_requests from public,anon,authenticated;
grant all on public.booking_benefit_change_requests to service_role;
create index booking_benefit_change_requests_booking_idx on public.booking_benefit_change_requests(booking_id);

create function public.member_update_booking_benefits_request(
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
      jsonb_build_object('requestId',p_request_id,'selectedCount',jsonb_array_length(normalized)));
  return answer;
end $$;
revoke all on function public.member_update_booking_benefits_request(text,uuid,timestamptz,text,jsonb) from public,anon,authenticated;
grant execute on function public.member_update_booking_benefits_request(text,uuid,timestamptz,text,jsonb) to service_role;

-- Preserve original sources, expose a bounded, redacted union through one admin RPC.
create index if not exists audit_logs_created_id_idx on public.audit_logs(created_at desc,id desc);
create index if not exists audit_logs_action_created_idx on public.audit_logs(action,created_at desc);
create index if not exists booking_audit_action_created_idx on public.booking_audit_events(action,created_at desc);
create index if not exists booking_audit_created_id_idx on public.booking_audit_events(created_at desc,id desc);

create function public.admin_query_operation_audit(
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
       or a.action ~ '^user\.booking\.receipt\.' or a.action ~ '^(LOGIN_|MEMBERSHIP_|MEMBER_|TICKET_|SNAPSHOT_|SETTINGS_)'
       or a.action='AUDIT_QUERY_VIEWED')
    union all
    select 'booking:'||a.id::text,a.actor_line_user_id,a.actor_role,a.action,a.target_type,a.target_id,a.result,a.metadata,a.created_at
    from public.booking_audit_events a
    where a.created_at>=p_from and a.created_at<p_to and a.action ~ '^(BOOKING_|SNAPSHOT_|TICKET_)'
  ), page as (
    select * from events e
    where (p_action='' or e.action=p_action) and (p_result='' or e.result=p_result)
      and (p_before_time is null or (e.created_at,e.event_id)<(p_before_time,p_before_id))
      and (p_member_code='' or e.actor=member_line or e.target_id in (member_line,member_uuid::text)
        or exists(select 1 from public.bookings b where b.id::text=e.target_id and b.member_id=member_uuid))
    order by created_at desc,event_id desc limit p_limit+1
  ), safe as (
    select created_at,event_id,jsonb_build_object('id',event_id,'actorRole',actor_role,
      'actor',case when actor is null or actor='' then 'system' else left(actor,5)||'…'||right(actor,3) end,
      'action',action,'targetType',target_type,
      'target',case when target_type in ('member','admin') or target_id ~ '^U[0-9a-f]{32}$'
        then left(target_id,5)||'…'||right(target_id,3) else left(target_id,100) end,
      'result',result,'createdAt',created_at,
      'detail',coalesce((select jsonb_object_agg(k,v) from jsonb_each(case when jsonb_typeof(metadata)='object' then metadata else '{}'::jsonb end) x(k,v)
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

-- A selection change also invalidates both ticket clients and the management view.
create function public.notify_booking_selection_surfaces() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into public.realtime_events(scope,event_type) values
    ('points','booking.benefits.changed'),('event','booking.benefits.changed'),('admin','booking.benefits.changed');
  return null;
end $$;
revoke all on function public.notify_booking_selection_surfaces() from public,anon,authenticated;
create trigger booking_selection_surfaces after insert or update or delete on public.booking_benefit_selections
for each statement execute function public.notify_booking_selection_surfaces();
-- Booking dates, cancellation and final settlement also change ticket context.
create trigger booking_ticket_context_surfaces after update on public.bookings
for each statement execute function public.notify_booking_selection_surfaces();

-- Existing business audit remains available for one year. Purge is bounded to
-- old rows, uses small locked batches and never touches member rights or bookings.
create function maintenance.prune_operation_audit() returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare removed int:=0; n int;
begin
  with old as (select id from public.audit_logs where created_at<now()-interval '365 days'
    order by created_at limit 1000 for update skip locked)
  delete from public.audit_logs a using old where a.id=old.id;
  get diagnostics n=row_count; removed:=removed+n;
  with old as (select id from public.booking_audit_events where created_at<now()-interval '365 days'
    order by created_at limit 1000 for update skip locked)
  delete from public.booking_audit_events a using old where a.id=old.id;
  get diagnostics n=row_count; removed:=removed+n;
  -- Old replay records cannot reapply a changed payload because version checks
  -- still reject it. Retain them with business audit for the same one year.
  with old as (select member_id,request_id from public.booking_benefit_change_requests
    where created_at<now()-interval '365 days' limit 1000 for update skip locked)
  delete from public.booking_benefit_change_requests a using old
    where a.member_id=old.member_id and a.request_id=old.request_id;
  return removed;
end $$;
revoke all on function maintenance.prune_operation_audit() from public,anon,authenticated;
grant execute on function maintenance.prune_operation_audit() to service_role;
do $$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('operation-audit-retention','25 19 * * *','select maintenance.prune_operation_audit();');
  end if;
end $$;

notify pgrst,'reload schema';
commit;
