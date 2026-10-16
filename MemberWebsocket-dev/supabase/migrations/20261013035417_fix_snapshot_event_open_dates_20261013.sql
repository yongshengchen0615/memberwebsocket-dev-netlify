-- Fix snapshot event claims with unbounded start/end dates. NULL means no date bound.
-- Preserve ownership, status, GPS proof, points budget, daily/transaction caps.
begin;
CREATE OR REPLACE FUNCTION public.validate_snapshot_ticket_selection(p_member uuid, p_booking uuid, p_benefits jsonb, p_receipt_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare item jsonb; kind text; ref text; title text; selections jsonb:='[]'; b public.bookings%rowtype;
 cost integer; card uuid; budget record; location_required boolean;
 v_reserved_points integer; v_balance integer; v_max_points integer; v_max_events integer; v_used_today integer;
begin
 if p_booking is not null then
 select * into b from public.bookings where id=p_booking for update;
 if not found or b.member_id<>p_member then raise exception 'BOOKING_NOT_OWNED'; end if;
 if b.status<>'confirmed' or b.completed_at is not null then raise exception 'BOOKING_TICKET_CONFIRMATION_REQUIRED'; end if;
 if b.cancellation_requested_at is not null and b.cancellation_reviewed_at is null then raise exception 'BOOKING_CANCELLATION_PENDING'; end if;
 end if;
 perform 1 from public.members where id=p_member and status='active' and membership_status='active' for update;
 if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
 if jsonb_typeof(p_benefits) is distinct from 'array' or jsonb_array_length(p_benefits)>20 then raise exception 'INVALID_BOOKING_BENEFITS'; end if;
 for item in select value from jsonb_array_elements(p_benefits) loop
 kind:=item->>'kind'; ref:=item->>'id';
 if kind not in ('points','event') or kind is null or coalesce(ref,'')='' or length(ref)>160
 or exists(select 1 from jsonb_array_elements(selections) s where s->>'kind'=kind and s->>'id'=ref) then raise exception 'INVALID_BOOKING_BENEFITS'; end if;
 if exists(select 1 from public.booking_benefit_selections s where s.member_id=p_member and s.benefit_kind=kind and s.benefit_ref=ref and s.status='pending' and s.booking_id is distinct from p_booking) then raise exception 'BOOKING_BENEFIT_RESERVED'; end if;
 if kind='points' then
 select t.ticket_title,t.threshold_stamps,t.point_card_id,t.requires_location into title,cost,card,location_required from public.point_tickets t
 join public.point_cards pc on pc.id=t.point_card_id where t.ticket_id=ref and t.member_id=p_member
 and t.status='available' and pc.status='active' and (pc.expiry_mode='unlimited' or pc.expires_on>=(clock_timestamp() at time zone 'Asia/Taipei')::date)
 for update of t;
 else
 select c.ticket_title,e.requires_location into title,location_required from public.event_ticket_claims c join public.event_tickets e on e.id=c.event_ticket_id
 where c.claim_id=ref and c.member_id=p_member and c.status='claimed' and e.status='active' and e.deleted_at is null
 and (e.starts_on is null or e.starts_on<=(clock_timestamp() at time zone 'Asia/Taipei')::date)
 and (e.ends_on is null or e.ends_on>=(clock_timestamp() at time zone 'Asia/Taipei')::date)
 and (cardinality(e.allowed_tier_keys)=0 or public.current_tier_key(p_member)=any(e.allowed_tier_keys))
 for update of c;
 end if;
 if not found then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
 -- Location rules must never be mistaken for the advance-booking policy.
 -- Snapshot review has no proof of GPS-based redemption at the configured site.
 if coalesce(location_required,false) and not public.snapshot_ticket_location_proven(p_receipt_id,p_member,kind,ref) then raise exception 'BOOKING_BENEFIT_LOCATION_REQUIRED'; end if;
 if p_booking is not null and not public.booking_ticket_matches_services(p_booking,p_member,kind,ref) then raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'; end if;
 selections:=selections||jsonb_build_array(jsonb_build_object('kind',kind,'id',ref,'title',title));
 end loop;
 for budget in select t.point_card_id,sum(t.threshold_stamps)::integer amount
 from jsonb_array_elements(selections) s join public.point_tickets t on t.ticket_id=s->>'id' and t.member_id=p_member where s->>'kind'='points' group by t.point_card_id loop
 -- Match the member point-card screen: subtract all OTHER pending bookings
 -- from the same card before accepting the snapshot batch.
 select coalesce(stamps,0) into v_balance from public.point_balances
   where member_id=p_member and point_card_id=budget.point_card_id for update;
 select coalesce(sum(t.threshold_stamps),0)::integer into v_reserved_points
   from public.booking_benefit_selections s join public.point_tickets t
   on t.member_id=s.member_id and t.ticket_id=s.benefit_ref
   where s.member_id=p_member and s.benefit_kind='points' and s.status='pending'
     and t.point_card_id=budget.point_card_id
     and (p_booking is null or s.booking_id is distinct from p_booking);
 if budget.amount>greatest(0,coalesce(v_balance,0)-v_reserved_points) then
   raise exception 'POINT_TICKET_INSUFFICIENT_POINTS';
 end if;
 end loop;
 select coalesce((select max_tickets_per_redemption from public.point_card_settings where id=1),1) into v_max_points;
 if v_max_points>0 and
 (select count(*) from jsonb_array_elements(selections) s where s->>'kind'='points')>v_max_points
 then raise exception 'TICKET_BATCH_LIMIT_EXCEEDED'; end if;
 select coalesce((select max_tickets_per_day from public.event_ticket_settings where id=1),1) into v_max_events;
 if v_max_events>0 then
   select count(*)::integer into v_used_today from public.event_ticket_claims c
   where c.member_id=p_member and c.status='used'
     and c.used_at>=(((clock_timestamp() at time zone 'Asia/Taipei')::date)::timestamp at time zone 'Asia/Taipei')
     and c.used_at<(((((clock_timestamp() at time zone 'Asia/Taipei')::date)+1)::timestamp) at time zone 'Asia/Taipei');
   if v_used_today+
      (select count(*) from jsonb_array_elements(selections) s where s->>'kind'='event')>v_max_events
   then raise exception 'EVENT_TICKET_DAILY_LIMIT_REACHED'; end if;
 end if;
 return selections;
end $function$;

revoke all on function public.validate_snapshot_ticket_selection(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.validate_snapshot_ticket_selection(uuid,uuid,jsonb,text) to service_role;
-- The later registration step must apply the same event-tier semantics:
-- an empty tier array means no tier restriction, not an invalid claim.
do $patch$ 
declare
  v_definition text;
  v_old constant text := 'if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception ''BOOKING_BENEFIT_NOT_AVAILABLE''; end if;';
  v_new constant text := 'if coalesce(cardinality(v_event.allowed_tier_keys),0) > 0 and not coalesce(v_tier = any(v_event.allowed_tier_keys),false) then raise exception ''BOOKING_BENEFIT_NOT_AVAILABLE''; end if;';
begin
  select pg_get_functiondef(p.oid) into v_definition
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='replace_booking_benefit_selections_request'
    and pg_get_function_identity_arguments(p.oid)='p_booking_id uuid, p_member_id uuid, p_selections jsonb';
  if v_definition is null or strpos(v_definition,v_old)=0 then
    raise exception 'SNAPSHOT_MIGRATION_EXPECTED_TIER_GUARD_NOT_FOUND';
  end if;
  execute replace(v_definition,v_old,v_new);
end $patch$;

commit;
