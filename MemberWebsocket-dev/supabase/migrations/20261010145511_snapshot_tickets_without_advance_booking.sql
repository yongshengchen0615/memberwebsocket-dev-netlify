-- Snapshot ticket intentions do not require an advance confirmed booking.
-- The global policy remains intact for normal ticket redemption.
begin;

create or replace function public.validate_snapshot_ticket_selection(p_member uuid,p_booking uuid,p_benefits jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item jsonb; kind text; ref text; title text; selections jsonb:='[]'; b public.bookings%rowtype;
 cost integer; card uuid; budget record;
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
 select t.ticket_title,t.threshold_stamps,t.point_card_id into title,cost,card from public.point_tickets t
 join public.point_cards pc on pc.id=t.point_card_id where t.ticket_id=ref and t.member_id=p_member
 and t.status='available' and pc.status='active' and (pc.expiry_mode='unlimited' or pc.expires_on>=(clock_timestamp() at time zone 'Asia/Taipei')::date)
 and not t.requires_location for update of t;
 else
 select c.ticket_title into title from public.event_ticket_claims c join public.event_tickets e on e.id=c.event_ticket_id
 where c.claim_id=ref and c.member_id=p_member and c.status='claimed' and e.status='active' and e.deleted_at is null
 and e.starts_on<=(clock_timestamp() at time zone 'Asia/Taipei')::date and e.ends_on>=(clock_timestamp() at time zone 'Asia/Taipei')::date
 and (cardinality(e.allowed_tier_keys)=0 or public.current_tier_key(p_member)=any(e.allowed_tier_keys))
 and not e.requires_location for update of c;
 end if;
 if not found then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
 if p_booking is not null and not public.booking_ticket_matches_services(p_booking,p_member,kind,ref) then raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'; end if;
 selections:=selections||jsonb_build_array(jsonb_build_object('kind',kind,'id',ref,'title',title));
 end loop;
 for budget in select t.point_card_id,sum(t.threshold_stamps)::integer amount
 from jsonb_array_elements(selections) s join public.point_tickets t on t.ticket_id=s->>'id' and t.member_id=p_member where s->>'kind'='points' group by t.point_card_id loop
 if budget.amount>coalesce((select stamps from public.point_balances where member_id=p_member and point_card_id=budget.point_card_id),0) then raise exception 'POINT_TICKET_INSUFFICIENT_POINTS'; end if;
 end loop;
 if (select count(*) from jsonb_array_elements(selections) s where s->>'kind'='points')>
 nullif((select max_tickets_per_redemption from public.point_card_settings where id=1),0) then raise exception 'TICKET_BATCH_LIMIT_EXCEEDED'; end if;
 if (select count(*) from jsonb_array_elements(selections) s where s->>'kind'='event')>
 nullif((select max_tickets_per_day from public.event_ticket_settings where id=1),0) then raise exception 'EVENT_TICKET_DAILY_LIMIT_REACHED'; end if;
 return selections;
end $$;

create or replace function public.register_snapshot_receipt_v2(p_receipt_id text,p_expected_receipt_updated_at timestamptz,p_actor text,p_booking_id uuid,p_booking_date date,p_start_time time,p_items jsonb,p_benefits jsonb,p_admin_note text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.booking_receipts%rowtype;
begin
 if not exists(select 1 from public.admins where line_user_id=p_actor and role='admin' and status='active') then raise exception 'ADMIN_REQUIRED'; end if;
 if p_booking_id is not null then perform 1 from public.bookings where id=p_booking_id for update; end if;
 select * into r from public.booking_receipts where receipt_id=p_receipt_id;
 perform 1 from public.members where id=r.member_id for update;
 select * into r from public.booking_receipts where receipt_id=p_receipt_id for update;
 perform 1 from public.booking_settings where id=1 for share;
 if r.status='awaiting_review' and jsonb_array_length(coalesce(p_benefits,'[]'::jsonb))>0 then
   -- Snapshot receipts are retrospective; admin reviews actual services later.
   -- Keep ownership, validity, point budget and ticket limits enforced.
   perform public.validate_snapshot_ticket_selection(r.member_id,null,p_benefits);
 end if;
 return public.register_accessible_receipt_with_benefits_request(p_receipt_id,p_expected_receipt_updated_at,p_actor,p_booking_id,p_booking_date,p_start_time,p_items,p_benefits,p_admin_note);
end $$;

-- Only the server may call these security-critical snapshot routines.
revoke all on function public.validate_snapshot_ticket_selection(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.register_snapshot_receipt_v2(text,timestamptz,text,uuid,date,time,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.validate_snapshot_ticket_selection(uuid,uuid,jsonb) to service_role;
grant execute on function public.register_snapshot_receipt_v2(text,timestamptz,text,uuid,date,time,jsonb,jsonb,text) to service_role;

commit;
