-- Additive, server-only service-item grants. Existing manual grants are unchanged.
create table public.service_grant_requests (
  actor_line_user_id text not null,
  request_id text not null,
  member_id uuid not null references public.members(id) on delete cascade,
  items jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(actor_line_user_id, request_id)
);
create index service_grant_requests_member_idx on public.service_grant_requests(member_id);
alter table public.service_grant_requests enable row level security;
revoke all on public.service_grant_requests from public, anon, authenticated;
grant all on public.service_grant_requests to service_role;

create function public.admin_service_grant_catalog(p_actor text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if not exists(select 1 from public.admins where line_user_id=p_actor and role='admin' and status='active') then
    raise exception 'ADMIN_REQUIRED';
  end if;
  return jsonb_build_object('services',coalesce((
    select jsonb_agg(jsonb_build_object(
      'serviceId',id,'title',title,'serviceType',service_type,'durationMinutes',duration_minutes,
      'countsTowardMembership',counts_toward_membership,'requiresCompanionService',requires_companion_service
    ) order by service_type,title,id) from public.booking_services where is_active and deleted_at is null
  ),'[]'::jsonb));
end;
$$;

create function public.preview_service_member_grant(p_actor text,p_member text,p_items jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_raw jsonb; v_service public.booking_services%rowtype; v_items jsonb := '[]';
  v_seen uuid[] := '{}'; v_quantity integer; v_minutes integer := 0; v_membership integer := 0;
  v_points jsonb; v_rules jsonb; v_main boolean := false; v_addon boolean := false;
begin
  if not exists(select 1 from public.admins where line_user_id=p_actor and role='admin' and status='active') then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists(select 1 from public.members where line_user_id=p_member and status='active' and membership_status='active') then raise exception 'MEMBER_NOT_AVAILABLE'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'INVALID_SERVICE_ITEMS'; end if;
  if jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>30 then raise exception 'INVALID_SERVICE_ITEMS'; end if;
  for v_raw in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_raw)<>'object' or jsonb_typeof(v_raw->'quantity') is distinct from 'number'
      or coalesce(v_raw->>'quantity','') !~ '^[12]$'
      or coalesce(v_raw->>'serviceId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then raise exception 'INVALID_SERVICE_ITEMS'; end if;
    v_quantity := (v_raw->>'quantity')::integer;
    select * into v_service from public.booking_services where id=(v_raw->>'serviceId')::uuid and is_active and deleted_at is null;
    if not found or v_service.id=any(v_seen) then raise exception 'SERVICE_NOT_AVAILABLE'; end if;
    v_seen := array_append(v_seen,v_service.id);
    v_minutes := v_minutes + v_service.duration_minutes*v_quantity;
    if v_service.counts_toward_membership then v_membership := v_membership+v_service.duration_minutes*v_quantity; end if;
    v_main := v_main or not v_service.requires_companion_service;
    v_addon := v_addon or v_service.requires_companion_service;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'serviceId',v_service.id,'title',v_service.title,'serviceType',v_service.service_type,
      'durationMinutes',v_service.duration_minutes,'quantity',v_quantity,
      'countsTowardMembership',v_service.counts_toward_membership,
      'requiresCompanionService',v_service.requires_companion_service,'updatedAt',v_service.updated_at
    ));
  end loop;
  if v_minutes<1 or v_minutes>1440 then raise exception 'INVALID_SERVICE_MINUTES'; end if;
  if v_addon and not v_main then raise exception 'SERVICE_COMPANION_REQUIRED'; end if;
  select coalesce(jsonb_agg(value order by value->>'serviceId'),'[]') into v_items from jsonb_array_elements(v_items);
  with minutes as (
    select lower(btrim(value->>'serviceType')) as type_key,
      sum((value->>'durationMinutes')::integer*(value->>'quantity')::integer)::integer as minutes
    from jsonb_array_elements(v_items) where (value->>'countsTowardMembership')::boolean
    group by lower(btrim(value->>'serviceType'))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'serviceType',t.name,'serviceTypeId',t.id,'minutes',m.minutes,'minutesPerPoint',r.minutes_per_point,
    'cardId',c.card_id,'cardTitle',c.title,'cardStatus',c.status,'expiryMode',c.expiry_mode,'expiresOn',c.expires_on,
    'amount',floor(m.minutes::numeric/r.minutes_per_point)::integer
  ) order by t.id,c.id),'[]') into v_rules
  from minutes m join public.booking_service_types t on lower(btrim(t.name))=m.type_key
  join public.booking_service_type_rewards r on r.service_type_id=t.id
  join public.point_cards c on c.id=r.point_card_id;
  if exists(select 1 from jsonb_array_elements(v_rules) where (value->>'amount')::integer>0 and
    (value->>'cardStatus'<>'active' or (value->>'expiryMode'<>'unlimited' and (value->>'expiresOn')::date<(clock_timestamp() at time zone 'Asia/Taipei')::date))) then raise exception 'POINT_CARD_NOT_AVAILABLE'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('cardId',card_id,'cardTitle',title,'amount',amount) order by card_id),'[]') into v_points from (
    select value->>'cardId' card_id,min(value->>'cardTitle') title,sum((value->>'amount')::integer)::integer amount
    from jsonb_array_elements(v_rules) group by value->>'cardId' having sum((value->>'amount')::integer)>0
  ) q;
  if exists(select 1 from jsonb_array_elements(v_points) where (value->>'amount')::integer>100) then raise exception 'INVALID_POINT_AMOUNT'; end if;
  if v_membership=0 and jsonb_array_length(v_points)=0 then raise exception 'EMPTY_GRANT'; end if;
  return jsonb_build_object('items',v_items,'totalMinutes',v_minutes,'serviceMinutes',v_membership,'points',v_points,'rules',v_rules);
end;
$$;

create function public.grant_service_member_benefits(p_actor text,p_member text,p_request text,p_items jsonb,p_expected_preview jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_member public.members%rowtype; v_previous public.service_grant_requests%rowtype;
  v_preview jsonb; v_result jsonb; v_points jsonb; v_note text;
begin
  if not exists(select 1 from public.admins where line_user_id=p_actor and role='admin' and status='active') then raise exception 'ADMIN_REQUIRED'; end if;
  if length(coalesce(p_request,''))<16 or length(p_request)>100 then raise exception 'INVALID_REQUEST_ID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('service-grant:'||p_actor||':'||p_request,0));
  select * into v_previous from public.service_grant_requests where actor_line_user_id=p_actor and request_id=p_request;
  if found then
    if v_previous.items is distinct from p_items or not exists(select 1 from public.members where id=v_previous.member_id and line_user_id=p_member) then raise exception 'GRANT_REQUEST_CONFLICT'; end if;
    return v_previous.result || jsonb_build_object('applied',false,'alreadyApplied',true);
  end if;
  -- Hold configuration stable until all balance/ledger changes have committed.
  lock table public.booking_services,public.booking_service_types,public.booking_service_type_rewards,public.point_cards in share mode;
  select * into v_member from public.members where line_user_id=p_member for update;
  if not found then raise exception 'MEMBER_NOT_FOUND'; end if;
  v_preview := public.preview_service_member_grant(p_actor,p_member,p_items);
  if p_expected_preview is distinct from v_preview then raise exception 'SERVICE_GRANT_PREVIEW_STALE'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('cardId',value->>'cardId','amount',(value->>'amount')::integer)),'[]') into v_points from jsonb_array_elements(v_preview->'points');
  select '依服務項目登記：'||string_agg(value->>'title'||' ×'||(value->>'quantity'),'、' order by value->>'serviceId') into v_note from jsonb_array_elements(v_preview->'items');
  v_result := public.grant_member_benefits(p_actor,p_member,'service:'||md5(p_actor||':'||p_request),v_points,nullif((v_preview->>'serviceMinutes')::integer,0),v_note);
  v_result := v_result || jsonb_build_object('preview',v_preview,'requestId',p_request);
  insert into public.service_grant_requests(actor_line_user_id,request_id,member_id,items,result) values(p_actor,p_request,v_member.id,p_items,v_result);
  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
    values(public.new_public_id('AUD'),p_actor,'admin','admin.service-grants.add','member',p_member,'success',jsonb_build_object('requestId',p_request,'preview',v_preview));
  return v_result;
end;
$$;
revoke all on function public.admin_service_grant_catalog(text),public.preview_service_member_grant(text,text,jsonb),public.grant_service_member_benefits(text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.admin_service_grant_catalog(text),public.preview_service_member_grant(text,text,jsonb),public.grant_service_member_benefits(text,text,text,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
