begin;
-- Persist only proof of GPS eligibility, never the raw coordinates.
alter table public.booking_receipts add column if not exists snapshot_location_verified_tickets jsonb not null default '[]'::jsonb;
alter table public.booking_receipts add constraint booking_receipts_snapshot_geo_array check (jsonb_typeof(snapshot_location_verified_tickets)='array');
create or replace function public.snapshot_ticket_location_proven(p_receipt_id text,p_member uuid,p_kind text,p_ticket_id text)
returns boolean language sql stable security invoker set search_path='' as $$
select exists(select 1 from public.booking_receipts r
  where r.receipt_id=p_receipt_id and r.member_id=p_member
    and r.submission_mode='accessible' and r.status in ('pending_upload','awaiting_review')
    and r.snapshot_location_verified_tickets @> jsonb_build_array(jsonb_build_object('kind',p_kind,'id',p_ticket_id)));
$$;
revoke all on function public.snapshot_ticket_location_proven(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.snapshot_ticket_location_proven(text,uuid,text,text) to service_role;


CREATE OR REPLACE FUNCTION public.validate_snapshot_ticket_selection(p_member uuid, p_booking uuid, p_benefits jsonb, p_receipt_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare item jsonb; kind text; ref text; title text; selections jsonb:='[]'; b public.bookings%rowtype;
 cost integer; card uuid; budget record; location_required boolean;
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
 and e.starts_on<=(clock_timestamp() at time zone 'Asia/Taipei')::date and e.ends_on>=(clock_timestamp() at time zone 'Asia/Taipei')::date
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
 if budget.amount>coalesce((select stamps from public.point_balances where member_id=p_member and point_card_id=budget.point_card_id),0) then raise exception 'POINT_TICKET_INSUFFICIENT_POINTS'; end if;
 end loop;
 if (select count(*) from jsonb_array_elements(selections) s where s->>'kind'='points')>
 nullif((select max_tickets_per_redemption from public.point_card_settings where id=1),0) then raise exception 'TICKET_BATCH_LIMIT_EXCEEDED'; end if;
 if (select count(*) from jsonb_array_elements(selections) s where s->>'kind'='event')>
 nullif((select max_tickets_per_day from public.event_ticket_settings where id=1),0) then raise exception 'EVENT_TICKET_DAILY_LIMIT_REACHED'; end if;
 return selections;
end $function$;


create or replace function public.validate_snapshot_ticket_selection(p_member uuid,p_booking uuid,p_benefits jsonb)
returns jsonb language sql security invoker set search_path='' as $$
 select public.validate_snapshot_ticket_selection(p_member,p_booking,p_benefits,null::text);
$$;

create or replace function public.prepare_snapshot_receipt_v2(
 p_member_id uuid,p_request_id text,p_object_path text,p_mime_type text,
 p_size_bytes integer,p_location jsonb,p_benefits jsonb,p_booking_id uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; requested jsonb; r public.booking_receipts%rowtype;
 item jsonb; kind text; ref text; locs jsonb; needed boolean;
 verified jsonb:='[]'::jsonb; fix jsonb:=null;
begin
 perform public.require_snapshot_location(p_location);
 if jsonb_typeof(p_benefits) is distinct from 'array'
   or jsonb_array_length(p_benefits)>20 then raise exception 'INVALID_BOOKING_BENEFITS'; end if;
 result:=public.prepare_accessible_receipt_request(p_member_id,p_request_id,p_object_path,p_mime_type,p_size_bytes);
 select * into r from public.booking_receipts where receipt_id=result->>'receiptId' for update;
 if coalesce((result->>'alreadyPrepared')::boolean,false) then
   requested:=public.validate_snapshot_ticket_selection(p_member_id,p_booking_id,p_benefits,r.receipt_id);
   if r.requested_benefits<>requested or r.requested_booking_id is distinct from p_booking_id then raise exception 'REQUEST_ID_CONFLICT'; end if;
 else
   for item in select value from jsonb_array_elements(p_benefits) loop
     kind:=item->>'kind'; ref:=item->>'id'; needed:=false; locs:=null;
     if kind='points' then
       select t.requires_location,t.redemption_locations into needed,locs
       from public.point_tickets t where t.member_id=p_member_id and t.ticket_id=ref;
     elsif kind='event' then
       select e.requires_location,e.redemption_locations into needed,locs
       from public.event_ticket_claims c join public.event_tickets e on e.id=c.event_ticket_id
       where c.member_id=p_member_id and c.claim_id=ref;
     end if;
     if coalesce(needed,false) then
       if p_location is null or jsonb_typeof(p_location)<>'object'
          or jsonb_typeof(p_location->'latitude') is distinct from 'number'
          or jsonb_typeof(p_location->'longitude') is distinct from 'number'
          or jsonb_typeof(p_location->'accuracy') is distinct from 'number'
          or jsonb_typeof(p_location->'timestamp') is distinct from 'number'
       then raise exception 'BOOKING_BENEFIT_LOCATION_REQUIRED'; end if;
       if fix is null then
         fix:=jsonb_build_object('latitude',p_location->'latitude',
           'longitude',p_location->'longitude','accuracy',p_location->'accuracy',
           'observedAt',to_timestamp((p_location->>'timestamp')::double precision/1000));
       end if;
       perform public.verify_ticket_redemption_locations(locs,fix);
       verified:=verified||jsonb_build_array(jsonb_build_object('kind',kind,'id',ref));
     end if;
   end loop;
   update public.booking_receipts set snapshot_location_verified_tickets=verified where id=r.id;
   requested:=public.validate_snapshot_ticket_selection(p_member_id,p_booking_id,p_benefits,r.receipt_id);
   update public.booking_receipts set requested_benefits=requested,requested_booking_id=p_booking_id where id=r.id;
 end if;
 return result;
end $$;

CREATE OR REPLACE FUNCTION public.finalize_snapshot_receipt_v2(p_receipt_id text, p_member_id uuid, p_actor_line_user_id text, p_actual_mime_type text, p_actual_size_bytes integer, p_sha256_hex text, p_location jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare r public.booking_receipts%rowtype; result jsonb;
begin
 select * into r from public.booking_receipts where receipt_id=p_receipt_id;
 if not found or r.member_id<>p_member_id then raise exception 'RECEIPT_NOT_OWNED'; end if;
 if r.status not in ('awaiting_review','bound') then
 perform public.validate_snapshot_ticket_selection(p_member_id,r.requested_booking_id,r.requested_benefits,r.receipt_id);
 end if;
 return public.finalize_snapshot_receipt_request(p_receipt_id,p_member_id,p_actor_line_user_id,p_actual_mime_type,p_actual_size_bytes,p_sha256_hex,p_location);
end $function$;


CREATE OR REPLACE FUNCTION public.register_snapshot_receipt_v2(p_receipt_id text, p_expected_receipt_updated_at timestamp with time zone, p_actor text, p_booking_id uuid, p_booking_date date, p_start_time time without time zone, p_items jsonb, p_benefits jsonb, p_admin_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare r public.booking_receipts%rowtype;
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
 end if;
 return public.register_accessible_receipt_with_benefits_request(p_receipt_id,p_expected_receipt_updated_at,p_actor,p_booking_id,p_booking_date,p_start_time,p_items,p_benefits,p_admin_note);
end $function$;


CREATE OR REPLACE FUNCTION public.replace_booking_benefit_selections_request(p_booking_id uuid, p_member_id uuid, p_selections jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_booking public.bookings%rowtype;
  v_item jsonb;
  v_kind text;
  v_ref text;
  v_title text;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_tier text;
  v_birthday date;
  v_point record;
  v_event record;
  v_calendar record;
begin
  select * into v_booking
  from public.bookings
  where id=p_booking_id and member_id=p_member_id
  for update;

  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.status not in ('pending','confirmed') then raise exception 'BOOKING_NOT_EDITABLE'; end if;

  p_selections := coalesce(p_selections,'[]'::jsonb);
  if jsonb_typeof(p_selections) <> 'array' or jsonb_array_length(p_selections) > 20 then
    raise exception 'INVALID_BOOKING_BENEFITS';
  end if;

  if exists (
    select 1
    from (
      select lower(btrim(value->>'kind')) as kind, btrim(value->>'id') as ref, count(*) as qty
      from jsonb_array_elements(p_selections)
      group by 1,2
      having count(*) > 1
    ) duplicated
  ) then
    raise exception 'INVALID_BOOKING_BENEFITS';
  end if;

  perform public.reconcile_booking_ticket_services(p_booking_id);
  select coalesce(jsonb_agg(item),'[]'::jsonb) into p_selections
  from jsonb_array_elements(p_selections) item
  where not exists(select 1 from public.booking_benefit_selections s
    where s.booking_id=p_booking_id and s.member_id=p_member_id
      and s.benefit_kind=lower(btrim(item->>'kind')) and s.benefit_ref=btrim(item->>'id')
      and s.status='cancelled' and s.result->>'cancellationReason'='booking_services_changed'
      and not public.booking_ticket_matches_services(p_booking_id,p_member_id,s.benefit_kind,s.benefit_ref));

  delete from public.booking_benefit_selections
  where booking_id=p_booking_id and status='pending';

  v_tier := public.current_tier_key(p_member_id);
  select birthday into v_birthday from public.members where id=p_member_id;

  for v_item in select value from jsonb_array_elements(p_selections)
  loop
    v_kind := lower(btrim(coalesce(v_item->>'kind','')));
    v_ref := btrim(coalesce(v_item->>'id',''));
    if v_kind not in ('points','event','calendar') or v_ref = '' or length(v_ref) > 160 then
      raise exception 'INVALID_BOOKING_BENEFITS';
    end if;

    v_title := '';

    if v_kind='points' then
      select
        pt.ticket_title,
        pc.title as card_title,
        pt.status as ticket_status,
        pt.requires_location,
        pc.status as card_status,
        pc.expiry_mode,
        pc.expires_on
      into v_point
      from public.point_tickets pt
      join public.point_cards pc on pc.id=pt.point_card_id
      where pt.member_id=p_member_id and pt.ticket_id=v_ref
      for update of pt,pc;

      if not found or v_point.ticket_status <> 'available' or v_point.card_status <> 'active' then
        raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
      end if;
      if coalesce(v_point.requires_location,false) and not public.snapshot_ticket_location_proven(current_setting('app.snapshot_receipt_id',true),p_member_id,'points',v_ref) then
        raise exception 'BOOKING_BENEFIT_LOCATION_REQUIRED';
      end if;
      if v_point.expiry_mode='date' and (v_point.expires_on is null or v_point.expires_on < v_today) then
        raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
      end if;
      v_title := concat_ws(
        '｜',
        nullif(btrim(coalesce(v_point.card_title,'')),''),
        coalesce(nullif(btrim(coalesce(v_point.ticket_title,'')),''),'集點卡票券')
      );

    elsif v_kind='event' then
      select
        c.ticket_title,
        c.status as claim_status,
        e.status as event_status,
        e.deleted_at,
        e.starts_on,
        e.ends_on,
        e.allowed_tier_keys,
        e.requires_location
      into v_event
      from public.event_ticket_claims c
      join public.event_tickets e on e.id=c.event_ticket_id
      where c.member_id=p_member_id and c.claim_id=v_ref
      for update of c,e;

      if not found or v_event.claim_status <> 'claimed'
         or v_event.event_status <> 'active' or v_event.deleted_at is not null then
        raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
      end if;
      if coalesce(v_event.requires_location,false) and not public.snapshot_ticket_location_proven(current_setting('app.snapshot_receipt_id',true),p_member_id,'event',v_ref) then
        raise exception 'BOOKING_BENEFIT_LOCATION_REQUIRED';
      end if;
      if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
      if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
      if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
      v_title := coalesce(v_event.ticket_title,'活動票券');

    else
      select ci.* into v_calendar
      from public.calendar_items ci
      where ci.calendar_item_id=v_ref and ci.item_type='event';

      if not found then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
      if v_calendar.starts_on > v_booking.booking_date
         or coalesce(v_calendar.ends_on,v_calendar.starts_on) < v_booking.booking_date then
        raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
      end if;
      if cardinality(v_calendar.allowed_tier_keys) > 0
         and not (v_tier = any(v_calendar.allowed_tier_keys)) then
        raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
      end if;
      if coalesce(v_calendar.audience_type,'all')='birthday_month' then
        if v_calendar.status <> 'targeted'
           or v_birthday is null
           or extract(month from v_birthday)::int <> v_calendar.audience_month then
          raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
        end if;
      elsif v_calendar.status <> 'active' then
        raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
      end if;
      v_title := coalesce(v_calendar.title,'會員活動');
    end if;

    insert into public.booking_benefit_selections(
      booking_id,member_id,benefit_kind,benefit_ref,title_snapshot,status
    ) values (
      p_booking_id,p_member_id,v_kind,v_ref,left(v_title,200),'pending'
    ) on conflict (booking_id,benefit_kind,benefit_ref) do update
      set status='pending',selected_at=now(),title_snapshot=excluded.title_snapshot,result=null
      where booking_benefit_selections.status='cancelled';
  end loop;
end;
$function$;


CREATE OR REPLACE FUNCTION public.complete_booking_with_benefits_request(p_booking_id uuid, p_expected_updated_at timestamp with time zone, p_actor text, p_admin_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_booking public.bookings%rowtype;
  v_member public.members%rowtype;
  v_selection public.booking_benefit_selections%rowtype;
  v_calendar public.calendar_items%rowtype;
  v_point_selection_ids uuid[];
  v_point_ids text[];
  v_event_ids text[];
  v_point_result jsonb := null;
  v_event_result jsonb := null;
  v_settlement jsonb;
  v_redemptions jsonb := '[]'::jsonb;
  v_tier text;
begin
  select * into v_booking
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
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

  select * into v_member
  from public.members
  where id = v_booking.member_id
  for update;

  if not found
     or v_member.membership_status <> 'active'
     or v_member.status <> 'active' then
    raise exception 'MEMBERSHIP_REQUIRED';
  end if;

  select
    array_agg(id order by benefit_ref),
    array_agg(benefit_ref order by benefit_ref)
    into v_point_selection_ids, v_point_ids
  from public.booking_benefit_selections
  where booking_id = p_booking_id
    and status = 'pending'
    and benefit_kind = 'points';

  select array_agg(benefit_ref order by benefit_ref)
    into v_event_ids
  from public.booking_benefit_selections
  where booking_id = p_booking_id
    and status = 'pending'
    and benefit_kind = 'event';

  v_tier := public.current_tier_key(v_booking.member_id);
  for v_selection in
    select *
    from public.booking_benefit_selections
    where booking_id = p_booking_id
      and status = 'pending'
      and benefit_kind = 'calendar'
    order by benefit_ref
    for update
  loop
    select * into v_calendar
    from public.calendar_items
    where calendar_item_id = v_selection.benefit_ref
      and item_type = 'event';

    if not found
       or v_calendar.starts_on > v_booking.booking_date
       or coalesce(v_calendar.ends_on, v_calendar.starts_on) < v_booking.booking_date
       or (
         cardinality(v_calendar.allowed_tier_keys) > 0
         and not (v_tier = any(v_calendar.allowed_tier_keys))
       ) then
      raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
    end if;

    if coalesce(v_calendar.audience_type, 'all') = 'birthday_month' then
      if v_calendar.status <> 'targeted'
         or v_member.birthday is null
         or extract(month from v_member.birthday)::int <> v_calendar.audience_month then
        raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
      end if;
    elsif v_calendar.status <> 'active' then
      raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
    end if;
  end loop;

  if coalesce(cardinality(v_point_ids), 0) > 0 then
    if exists (
      select 1
      from public.point_tickets pt
      where pt.member_id = v_booking.member_id
        and pt.ticket_id = any(v_point_ids)
        and coalesce(pt.requires_location, false)
         and not public.snapshot_ticket_location_proven(current_setting('app.snapshot_receipt_id',true),v_booking.member_id,'points',pt.ticket_id)
    ) then
      raise exception 'BOOKING_BENEFIT_LOCATION_REQUIRED';
    end if;

    -- Release only this booking's held points inside the same transaction.
    -- Any later failure rolls this status change and the point redemption back together.
    update public.booking_benefit_selections
    set status = 'redeemed'
    where id = any(v_point_selection_ids)
      and status = 'pending'
      and benefit_kind = 'points';

    v_point_result := public.redeem_point_tickets(
      v_member.line_user_id,
      v_point_ids,
      'BOOKING_POINT_' || replace(p_booking_id::text, '-', '')
    );
  end if;

  if coalesce(cardinality(v_event_ids), 0) > 0 then
    v_event_result := public.redeem_event_tickets_with_location(
      v_member.line_user_id,
      v_event_ids,
      'BOOKING_EVENT_' || replace(p_booking_id::text, '-', ''),
      null
    );
  end if;

  v_settlement := public.complete_booking_with_rewards_request(
    p_booking_id,
    p_expected_updated_at,
    p_actor,
    left(coalesce(p_admin_note, ''), 500)
  );

  if coalesce(cardinality(v_point_selection_ids), 0) > 0 then
    update public.booking_benefit_selections
    set redeemed_at = now(),
        redeemed_by = p_actor,
        result = v_point_result
    where id = any(v_point_selection_ids)
      and status = 'redeemed'
      and benefit_kind = 'points';
  end if;

  update public.booking_benefit_selections
  set status = 'redeemed',
      redeemed_at = now(),
      redeemed_by = p_actor,
      result = v_event_result
  where booking_id = p_booking_id
    and status = 'pending'
    and benefit_kind = 'event';

  update public.booking_benefit_selections
  set status = 'applied',
      redeemed_at = now(),
      redeemed_by = p_actor,
      result = jsonb_build_object('activityApplied', true)
  where booking_id = p_booking_id
    and status = 'pending'
    and benefit_kind = 'calendar';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind', benefit_kind,
        'id', benefit_ref,
        'title', title_snapshot,
        'status', status,
        'result', result
      )
      order by selected_at, id
    ),
    '[]'::jsonb
  )
    into v_redemptions
  from public.booking_benefit_selections
  where booking_id = p_booking_id
    and status in ('redeemed', 'applied');

  insert into public.audit_logs(
    audit_id,
    actor_line_user_id,
    actor_role,
    action,
    target_type,
    target_id,
    result,
    detail
  ) values (
    public.new_public_id('AUD'),
    p_actor,
    'admin',
    'admin.booking.benefits.redeem',
    'booking',
    p_booking_id::text,
    'success',
    jsonb_build_object('redemptions', v_redemptions)
  );

  return coalesce(v_settlement, '{}'::jsonb)
    || jsonb_build_object('redemptions', v_redemptions);
end;
$function$;


CREATE OR REPLACE FUNCTION public.redeem_event_tickets_with_location(p_line_user_id text, p_claim_ids text[], p_request_id text, p_location jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_member public.members%rowtype;
  v_claim public.event_ticket_claims%rowtype;
  v_event public.event_tickets%rowtype;
  v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
  v_day_start timestamptz := (v_today::timestamp at time zone 'Asia/Taipei');
  v_day_end timestamptz := ((v_today + 1)::timestamp at time zone 'Asia/Taipei');
  v_tier text;
  v_max_tickets integer := 1;
  v_used_today_count integer := 0;
  v_selected_count integer := 0;
  v_processed integer := 0;
  v_result jsonb := null;
  v_results jsonb := '[]'::jsonb;
  v_existing jsonb;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then
    raise exception 'INVALID_REQUEST_ID';
  end if;
  if p_claim_ids is null or cardinality(p_claim_ids) < 1 or cardinality(p_claim_ids) > 50 then
    raise exception 'INVALID_EVENT_TICKET_BATCH';
  end if;
  if exists(
    select 1 from unnest(p_claim_ids) as selected(claim_id)
    where nullif(btrim(selected.claim_id),'') is null
  ) then
    raise exception 'INVALID_EVENT_TICKET_BATCH';
  end if;
  if (select count(distinct selected.claim_id) from unnest(p_claim_ids) as selected(claim_id)) <> cardinality(p_claim_ids) then
    raise exception 'INVALID_EVENT_TICKET_BATCH';
  end if;

  select * into v_member
  from public.members
  where line_user_id=p_line_user_id
    and membership_status='active'
    and status='active'
  for update;
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select detail into v_existing
  from public.audit_logs
  where actor_line_user_id=v_member.line_user_id
    and action='user.event.tickets.redeem'
    and target_type='event_claim_batch'
    and target_id=p_request_id
    and result='success'
  order by created_at desc
  limit 1;
  if found then
    return coalesce(v_existing,'{}'::jsonb)
      || jsonb_build_object('requestId',p_request_id,'alreadyApplied',true);
  end if;

  select coalesce(max_tickets_per_day, 1)
    into v_max_tickets
  from public.event_ticket_settings
  where id=1;
  v_max_tickets := coalesce(v_max_tickets,1);

  select count(*)::integer into v_used_today_count
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.status='used'
    and c.used_at >= v_day_start
    and c.used_at < v_day_end;

  if v_max_tickets > 0 and v_used_today_count + cardinality(p_claim_ids) > v_max_tickets then
    raise exception 'EVENT_TICKET_DAILY_LIMIT_REACHED';
  end if;

  perform 1
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.claim_id=any(p_claim_ids)
  order by c.claim_id
  for update;

  select count(*)::integer into v_selected_count
  from public.event_ticket_claims c
  where c.member_id=v_member.id
    and c.claim_id=any(p_claim_ids);
  if v_selected_count <> cardinality(p_claim_ids) then
    raise exception 'CLAIM_NOT_FOUND';
  end if;

  if exists(
    select 1
    from public.event_ticket_claims c
    where c.member_id=v_member.id
      and c.claim_id=any(p_claim_ids)
      and c.status <> 'claimed'
  ) then
    raise exception 'CLAIM_NOT_AVAILABLE';
  end if;

  perform 1
  from public.event_tickets e
  where e.id in (
    select c.event_ticket_id
    from public.event_ticket_claims c
    where c.member_id=v_member.id
      and c.claim_id=any(p_claim_ids)
  )
  order by e.id
  for update;

  v_tier := public.current_tier_key(v_member.id);

  for v_claim in
    select c.*
    from public.event_ticket_claims c
    where c.member_id=v_member.id
      and c.claim_id=any(p_claim_ids)
    order by c.claim_id
  loop
    select * into v_event
    from public.event_tickets
    where id=v_claim.event_ticket_id
      and deleted_at is null;

    if not found or v_event.status <> 'active' then raise exception 'EVENT_TICKET_NOT_AVAILABLE'; end if;
    if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'EVENT_NOT_STARTED'; end if;
    if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'EVENT_ENDED'; end if;
    if not (v_tier = any(v_event.allowed_tier_keys)) then raise exception 'TIER_NOT_ALLOWED'; end if;
    if v_event.requires_location and not public.snapshot_ticket_location_proven(current_setting('app.snapshot_receipt_id',true),v_member.id,'event',v_claim.claim_id) then
      perform public.verify_ticket_redemption_locations(v_event.redemption_locations,p_location);
    end if;

    v_result := null;
    if v_claim.ticket_type='lottery' then
      v_result := public.pick_lottery_prize(v_claim.prizes);
    end if;

    update public.event_ticket_claims
    set status='used',
        used_at=now(),
        result=v_result,
        updated_at=now()
    where id=v_claim.id
      and status='claimed';
    if not found then raise exception 'CLAIM_NOT_AVAILABLE'; end if;

    v_processed := v_processed + 1;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'claimId',v_claim.claim_id,
      'eventTicketId',v_event.event_ticket_id,
      'ticketTitle',v_claim.ticket_title,
      'ticketType',v_claim.ticket_type,
      'result',v_result
    ));
  end loop;

  v_existing := jsonb_build_object(
    'requestId',p_request_id,
    'claimIds',to_jsonb(p_claim_ids),
    'ticketCount',v_processed,
    'maxTicketsPerDay',v_max_tickets,
    'businessDate',v_today,
    'usedTodayCount',v_used_today_count + v_processed,
    'remainingTodayCount',case when v_max_tickets = 0 then null else greatest(v_max_tickets - (v_used_today_count + v_processed),0) end,
    'tickets',v_results,
    'alreadyApplied',false
  );

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values (
    public.new_public_id('AUD'),
    v_member.line_user_id,
    'member',
    'user.event.tickets.redeem',
    'event_claim_batch',
    p_request_id,
    'success',
    v_existing
  );

  return v_existing;
end;
$function$;


revoke all on function public.validate_snapshot_ticket_selection(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.validate_snapshot_ticket_selection(uuid,uuid,jsonb,text) to service_role;
revoke all on function public.validate_snapshot_ticket_selection(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.validate_snapshot_ticket_selection(uuid,uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;