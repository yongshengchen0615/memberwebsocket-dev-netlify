-- Snapshot point redemption may precede a later confirmed reservation
-- for the SAME reward when the balance funds BOTH uses.
-- Never redeem the one issued ticket twice: rotate the future booking's
-- reservation to a distinct, audited issued ticket in the approval transaction.
begin;
alter table public.point_tickets
  add column if not exists snapshot_reservation_copy_of text;
alter table public.point_tickets
  add constraint point_ticket_snapshot_copy_self_check
  check (snapshot_reservation_copy_of is null or snapshot_reservation_copy_of<>ticket_id);
drop index if exists public.point_ticket_one_available_per_reward;
create unique index point_ticket_one_available_per_reward
  on public.point_tickets(member_id,reward_id)
  where status='available' and reward_id is not null
    and snapshot_reservation_copy_of is null;
create unique index point_ticket_unique_snapshot_reservation_copy
  on public.point_tickets(member_id,snapshot_reservation_copy_of)
  where snapshot_reservation_copy_of is not null;

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
 -- A future general booking reserves its own ticket and its share of points.
 -- A current snapshot may use that ticket only if the remaining unreserved
 -- balance can independently fund today's redemption. The future booking's
 -- ticket reference is replaced atomically before today's approval settles.
 if exists(
   select 1 from public.booking_benefit_selections s
   left join public.bookings future on future.id=s.booking_id
   where s.member_id=p_member and s.benefit_kind=kind and s.benefit_ref=ref
     and s.status='pending' and s.booking_id is distinct from p_booking
     and (
       kind<>'points' or p_booking is not null
       or future.id is null or future.status<>'confirmed'
       or future.completed_at is not null
       or future.start_at<=(clock_timestamp() at time zone 'Asia/Taipei')
     )
 ) then raise exception 'BOOKING_BENEFIT_RESERVED'; end if;
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
end $function$
;

CREATE OR REPLACE FUNCTION public.register_snapshot_receipt_v2(p_receipt_id text, p_expected_receipt_updated_at timestamp with time zone, p_actor text, p_booking_id uuid, p_booking_date date, p_start_time time without time zone, p_items jsonb, p_benefits jsonb, p_admin_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare r public.booking_receipts%rowtype;
 v_item jsonb; v_ref text; v_new_id text; v_selection_id uuid; v_future_booking_id uuid;
begin
 if not exists(select 1 from public.admins where line_user_id=p_actor and role='admin' and status='active') then raise exception 'ADMIN_REQUIRED'; end if;
 if p_booking_id is not null then perform 1 from public.bookings where id=p_booking_id for update; end if;
 select * into r from public.booking_receipts where receipt_id=p_receipt_id;
 if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;
 perform set_config('app.snapshot_receipt_id',r.receipt_id,true);
 perform 1 from public.members where id=r.member_id for update;
 select * into r from public.booking_receipts where receipt_id=p_receipt_id for update;
 perform 1 from public.booking_settings where id=1 for share;
 if r.status='awaiting_review' and jsonb_array_length(coalesce(p_benefits,'[]'::jsonb))>0 then
   -- Snapshot receipts are retrospective; admin reviews actual services later.
   -- Keep ownership, validity, point budget and ticket limits enforced.
   perform public.validate_snapshot_ticket_selection(r.member_id,null,p_benefits,r.receipt_id);
   -- Validate optimistic version BEFORE modifying future reservations.
   if r.updated_at is distinct from p_expected_receipt_updated_at then
     raise exception 'BOOKING_CONFLICT';
   end if;
   for v_item in select value from jsonb_array_elements(p_benefits) loop
     if v_item->>'kind'<>'points' then continue; end if;
     v_ref:=v_item->>'id';
     v_selection_id:=null;
     v_future_booking_id:=null;
     select s.id,s.booking_id into v_selection_id,v_future_booking_id
     from public.booking_benefit_selections s
     where s.member_id=r.member_id and s.benefit_kind='points'
       and s.benefit_ref=v_ref and s.status='pending'
     for update;
     if not found then continue; end if;
     perform 1 from public.bookings b
     where b.id=v_future_booking_id and b.member_id=r.member_id
       and b.status='confirmed' and b.completed_at is null
       and b.start_at>(clock_timestamp() at time zone 'Asia/Taipei')
     for update;
     if not found then raise exception 'BOOKING_BENEFIT_RESERVED'; end if;
     -- Keep the issued ticket for today's reviewed snapshot. Rebind the
     -- later booking to a distinct issued instance of the same reward.
     -- Both debit the same balance, but the validator already proved
     -- that today's spend is covered on top of all reserved points.
     v_new_id:=public.new_public_id('PT');
     insert into public.point_tickets(
       ticket_id,member_id,point_card_id,reward_id,ticket_template_id,
       threshold_stamps,ticket_type,ticket_title,ticket_description,
       usage_method,usage_instructions,prizes,requires_location,
       redemption_locations,snapshot_reservation_copy_of
     )
     select v_new_id,t.member_id,t.point_card_id,t.reward_id,t.ticket_template_id,
       t.threshold_stamps,t.ticket_type,t.ticket_title,t.ticket_description,
       t.usage_method,t.usage_instructions,t.prizes,t.requires_location,
       t.redemption_locations,t.ticket_id
     from public.point_tickets t
     where t.member_id=r.member_id and t.ticket_id=v_ref and t.status='available'
     for update;
     if not found then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
     update public.booking_benefit_selections
     set benefit_ref=v_new_id
     where id=v_selection_id and member_id=r.member_id
       and benefit_kind='points' and benefit_ref=v_ref and status='pending';
     if not found then raise exception 'BOOKING_CONFLICT'; end if;
     insert into public.audit_logs(
       audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
     ) values (
       public.new_public_id('AUD'),p_actor,'admin',
       'admin.booking.receipt.snapshot.reservation-rebind',
       'booking_benefit_selection',v_selection_id::text,'success',
       jsonb_build_object('receiptId',r.receipt_id,'futureBookingId',v_future_booking_id,
         'snapshotTicketId',v_ref,'futureTicketId',v_new_id)
     );
   end loop;
 end if;
 return public.register_accessible_receipt_with_benefits_request(p_receipt_id,p_expected_receipt_updated_at,p_actor,p_booking_id,p_booking_date,p_start_time,p_items,p_benefits,p_admin_note);
end $function$
;

commit;
