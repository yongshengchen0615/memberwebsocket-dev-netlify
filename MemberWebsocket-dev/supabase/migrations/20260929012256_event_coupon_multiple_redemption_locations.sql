-- Preserve existing locations; never weaken the original single-location constraint.
alter table public.event_tickets
  add column if not exists redemption_locations jsonb not null default '[]'::jsonb;

update public.event_tickets
set redemption_locations = jsonb_build_array(jsonb_build_object(
  'name', '原核銷地點', 'latitude', redemption_latitude,
  'longitude', redemption_longitude, 'radiusMeters', redemption_radius_meters
))
where requires_location and redemption_locations = '[]'::jsonb;

-- Keep the previous API version writable while the new Edge Function rolls out.
create or replace function public.sync_legacy_ticket_redemption_location()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $function$
begin
  if not new.requires_location then
    new.redemption_locations := '[]'::jsonb;
  elsif new.redemption_locations = '[]'::jsonb and new.redemption_latitude is not null
    and new.redemption_longitude is not null and new.redemption_radius_meters is not null then
    new.redemption_locations := jsonb_build_array(jsonb_build_object(
      'name', '原核銷地點', 'latitude', new.redemption_latitude,
      'longitude', new.redemption_longitude, 'radiusMeters', new.redemption_radius_meters));
  end if;
  return new;
end;
$function$;
drop trigger if exists sync_legacy_ticket_redemption_location on public.event_tickets;
create trigger sync_legacy_ticket_redemption_location before insert or update on public.event_tickets
for each row execute function public.sync_legacy_ticket_redemption_location();
revoke all on function public.sync_legacy_ticket_redemption_location() from public, anon, authenticated;

create or replace function public.event_ticket_locations_valid(p_locations jsonb)
returns boolean language plpgsql immutable security invoker set search_path = public, pg_temp as $function$
declare v_location jsonb;
begin
  if jsonb_typeof(p_locations) is distinct from 'array'
    or jsonb_array_length(p_locations) not between 1 and 20 then return false; end if;
  for v_location in select value from jsonb_array_elements(p_locations) loop
    if jsonb_typeof(v_location) is distinct from 'object'
      or jsonb_typeof(v_location->'name') is distinct from 'string'
      or length(btrim(v_location->>'name')) not between 1 and 100
      or jsonb_typeof(v_location->'latitude') is distinct from 'number'
      or jsonb_typeof(v_location->'longitude') is distinct from 'number'
      or jsonb_typeof(v_location->'radiusMeters') is distinct from 'number'
    then return false; end if;
    if (v_location->>'latitude')::numeric not between -90 and 90
      or (v_location->>'longitude')::numeric not between -180 and 180
      or (v_location->>'radiusMeters')::numeric not between 50 and 2000
      or (v_location->>'radiusMeters')::numeric <> trunc((v_location->>'radiusMeters')::numeric)
    then return false; end if;
  end loop;
  return true;
end;
$function$;
revoke all on function public.event_ticket_locations_valid(jsonb) from public, anon, authenticated;
grant execute on function public.event_ticket_locations_valid(jsonb) to service_role;

alter table public.event_tickets add constraint event_tickets_redemption_locations_valid check (
  (not requires_location and redemption_locations = '[]'::jsonb)
  or (requires_location and public.event_ticket_locations_valid(redemption_locations))
);

-- Use the existing freshness/accuracy/distance validator for each configured site.
create or replace function public.verify_ticket_redemption_locations(p_locations jsonb, p_location jsonb)
returns void language plpgsql security invoker set search_path = public, pg_temp as $function$
declare v_location jsonb;
begin
  if not public.event_ticket_locations_valid(p_locations) then raise exception 'LOCATION_RULE_INVALID'; end if;
  for v_location in select value from jsonb_array_elements(p_locations) loop
    begin
      perform public.verify_ticket_redemption_location(
        (v_location->>'latitude')::numeric, (v_location->>'longitude')::numeric,
        (v_location->>'radiusMeters')::integer, p_location);
      return;
    exception when raise_exception then
      if sqlerrm <> 'LOCATION_OUT_OF_RANGE' then raise; end if;
    end;
  end loop;
  raise exception 'LOCATION_OUT_OF_RANGE';
end;
$function$;
revoke all on function public.verify_ticket_redemption_locations(jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.verify_ticket_redemption_locations(jsonb,jsonb) to service_role;

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
    perform public.verify_ticket_redemption_locations(v_event.redemption_locations,p_location);
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
