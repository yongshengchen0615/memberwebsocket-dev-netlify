-- A ticket's location rule is optional for existing tickets and fixed benefits.
alter table public.event_tickets
  add column if not exists requires_location boolean not null default false,
  add column if not exists redemption_latitude numeric(9,6),
  add column if not exists redemption_longitude numeric(9,6),
  add column if not exists redemption_radius_meters integer;

alter table public.event_tickets
  add constraint event_tickets_redemption_location_valid check (
    (requires_location = false and redemption_latitude is null and redemption_longitude is null and redemption_radius_meters is null)
    or (requires_location = true and ticket_type = 'coupon'
      and redemption_latitude is not null and redemption_longitude is not null and redemption_radius_meters is not null
      and redemption_latitude between -90 and 90
      and redemption_longitude between -180 and 180 and redemption_radius_meters between 50 and 2000)
  );

-- Aggregate in Postgres: PostgREST's default row cap must not undercount stock.
create or replace function public.event_ticket_claim_counts(p_event_ids uuid[])
returns table(event_ticket_id uuid, claimed_count bigint)
language sql stable security invoker set search_path = public, pg_temp as $function$
  select c.event_ticket_id, count(*) from public.event_ticket_claims c
  where c.event_ticket_id = any(p_event_ids) group by c.event_ticket_id;
$function$;
revoke all on function public.event_ticket_claim_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.event_ticket_claim_counts(uuid[]) to service_role;

-- Shared validation entry point for future ticket redemption flows. The browser
-- supplies a measurement; the server checks freshness, accuracy, and radius.
create or replace function public.verify_ticket_redemption_location(
  p_latitude numeric, p_longitude numeric, p_radius_meters integer, p_location jsonb
) returns void language plpgsql security invoker set search_path = public, pg_temp as $function$
declare
  v_lat numeric;
  v_lng numeric;
  v_accuracy numeric;
  v_observed_at timestamptz;
  v_distance double precision;
begin
  if p_location is null or jsonb_typeof(p_location) <> 'object'
    or jsonb_typeof(p_location->'latitude') <> 'number'
    or jsonb_typeof(p_location->'longitude') <> 'number'
    or jsonb_typeof(p_location->'accuracy') <> 'number'
    or jsonb_typeof(p_location->'observedAt') <> 'string'
  then raise exception 'LOCATION_REQUIRED'; end if;
  begin
    v_lat := (p_location->>'latitude')::numeric;
    v_lng := (p_location->>'longitude')::numeric;
    v_accuracy := (p_location->>'accuracy')::numeric;
    v_observed_at := (p_location->>'observedAt')::timestamptz;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'LOCATION_INVALID';
  end;
  if v_lat not between -90 and 90 or v_lng not between -180 and 180
    or v_accuracy <= 0 or v_accuracy > 100
    or v_observed_at < clock_timestamp() - interval '2 minutes'
    or v_observed_at > clock_timestamp() + interval '30 seconds'
  then raise exception 'LOCATION_INVALID'; end if;
  v_distance := 6371000 * 2 * asin(sqrt(least(1.0,
    power(sin(radians((v_lat - p_latitude)::double precision) / 2), 2)
    + cos(radians(p_latitude::double precision)) * cos(radians(v_lat::double precision))
      * power(sin(radians((v_lng - p_longitude)::double precision) / 2), 2)
  )));
  if v_distance + v_accuracy > p_radius_meters then raise exception 'LOCATION_OUT_OF_RANGE'; end if;
end;
$function$;
revoke all on function public.verify_ticket_redemption_location(numeric,numeric,integer,jsonb) from public, anon, authenticated;
grant execute on function public.verify_ticket_redemption_location(numeric,numeric,integer,jsonb) to service_role;

-- Serialize claims on the event row and check an existing claim before stock.
create or replace function public.claim_event_ticket(p_line_user_id text, p_event_ticket_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $function$
declare
  v_member public.members%rowtype;
  v_event public.event_tickets%rowtype;
  v_tier text;
  v_claim_id text;
  v_today date;
  v_count integer;
begin
  select * into v_member from public.members
    where line_user_id=p_line_user_id and membership_status='active' and status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  select * into v_event from public.event_tickets
    where event_ticket_id=p_event_ticket_id and deleted_at is null for update;
  if not found or v_event.status <> 'active' then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  v_today := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  if v_event.fixed_ticket_template_id is not null then raise exception 'FIXED_TICKET_AUTO_ONLY'; end if;
  if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'EVENT_NOT_STARTED'; end if;
  if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'EVENT_ENDED'; end if;
  v_tier := public.current_tier_key(v_member.id);
  if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;

  select claim_id into v_claim_id from public.event_ticket_claims
    where event_ticket_id=v_event.id and member_id=v_member.id;
  if found then return jsonb_build_object('claimId',v_claim_id,'alreadyClaimed',true); end if;
  if v_event.quota > 0 then
    select count(*)::integer into v_count from public.event_ticket_claims where event_ticket_id=v_event.id;
    if v_count >= v_event.quota then raise exception 'EVENT_QUOTA_REACHED'; end if;
  end if;
  v_claim_id := public.new_public_id('EC');
  insert into public.event_ticket_claims(
    claim_id,event_ticket_id,member_id,ticket_type,ticket_title,ticket_description,usage_method,usage_instructions,prizes
  ) values (
    v_claim_id,v_event.id,v_member.id,v_event.ticket_type,v_event.title,v_event.description,v_event.usage_method,v_event.usage_instructions,v_event.prizes
  );
  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result)
    values(public.new_public_id('AUD'),v_member.line_user_id,'member','user.event.ticket.claim','event_ticket',v_event.event_ticket_id,'success');
  return jsonb_build_object('claimId',v_claim_id,'alreadyClaimed',false);
end;
$function$;
revoke all on function public.claim_event_ticket(text,text) from public, anon, authenticated;
grant execute on function public.claim_event_ticket(text,text) to service_role;

create or replace function public.redeem_event_ticket(p_line_user_id text, p_claim_id text, p_location jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $function$
declare
  v_member public.members%rowtype;
  v_claim public.event_ticket_claims%rowtype;
  v_event public.event_tickets%rowtype;
  v_tier text;
  v_result jsonb := null;
  v_today date;
begin
  select * into v_member from public.members
    where line_user_id=p_line_user_id and membership_status='active' and status='active';
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  select * into v_claim from public.event_ticket_claims
    where claim_id=p_claim_id and member_id=v_member.id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.status='used' then return jsonb_build_object('claimId',v_claim.claim_id,'alreadyUsed',true); end if;
  if v_claim.status <> 'claimed' then raise exception 'CLAIM_NOT_AVAILABLE'; end if;
  select * into v_event from public.event_tickets where id=v_claim.event_ticket_id and deleted_at is null for update;
  if not found or v_event.status <> 'active' then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
  v_today := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'EVENT_NOT_STARTED'; end if;
  if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'EVENT_ENDED'; end if;
  v_tier := public.current_tier_key(v_member.id);
  if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;
  if v_event.requires_location then
    perform public.verify_ticket_redemption_location(
      v_event.redemption_latitude,v_event.redemption_longitude,v_event.redemption_radius_meters,p_location);
  end if;
  if v_claim.ticket_type='lottery' then v_result := public.pick_lottery_prize(v_claim.prizes); end if;
  update public.event_ticket_claims set status='used',used_at=now(),result=v_result,updated_at=now()
    where id=v_claim.id and status='claimed';
  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result)
    values(public.new_public_id('AUD'),v_member.line_user_id,'member','user.event.ticket.redeem','event_claim',v_claim.claim_id,'success');
  return jsonb_build_object('claimId',v_claim.claim_id,'alreadyUsed',false);
end;
$function$;
revoke all on function public.redeem_event_ticket(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.redeem_event_ticket(text,text,jsonb) to service_role;

-- Preserve old internal callers without allowing a location-gated ticket to bypass verification.
create or replace function public.redeem_event_ticket(p_line_user_id text, p_claim_id text)
returns jsonb language sql security definer set search_path = public, pg_temp as $function$
  select public.redeem_event_ticket(p_line_user_id,p_claim_id,null::jsonb);
$function$;
revoke all on function public.redeem_event_ticket(text,text) from public, anon, authenticated;
grant execute on function public.redeem_event_ticket(text,text) to service_role;
