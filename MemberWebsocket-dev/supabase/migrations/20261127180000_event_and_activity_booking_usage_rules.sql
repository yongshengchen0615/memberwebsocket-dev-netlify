-- AC-001..AC-006: booking party-size and activity usage rules.
-- Backwards compatible defaults: zero limits and no service/amount rules.
ALTER TABLE public.event_tickets
  ADD COLUMN IF NOT EXISTS min_booking_party_size smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_booking_party_size smallint NOT NULL DEFAULT 0;
ALTER TABLE public.calendar_items
  ADD COLUMN IF NOT EXISTS required_service_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS required_service_match_mode text NOT NULL DEFAULT 'any',
  ADD COLUMN IF NOT EXISTS required_service_groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS min_booking_amount_mode text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS min_booking_amount integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_booking_service_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS min_booking_party_size smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_booking_party_size smallint NOT NULL DEFAULT 0;

ALTER TABLE public.event_tickets ADD CONSTRAINT event_ticket_booking_party_size_chk
  CHECK (min_booking_party_size BETWEEN 0 AND 20 AND max_booking_party_size BETWEEN 0 AND 20
    AND (max_booking_party_size = 0 OR max_booking_party_size >= greatest(1,min_booking_party_size)));
ALTER TABLE public.calendar_items ADD CONSTRAINT calendar_booking_rule_chk CHECK (
  required_service_match_mode IN ('any','all')
  AND jsonb_typeof(required_service_groups) = 'array'
  AND min_booking_amount_mode IN ('none','total','selected_services')
  AND min_booking_amount BETWEEN 0 AND 10000000
  AND (min_booking_amount_mode = 'none' AND min_booking_amount=0 OR min_booking_amount_mode <> 'none' AND min_booking_amount > 0)
  AND (min_booking_amount_mode <> 'selected_services' OR cardinality(min_booking_service_ids)>0)
  AND min_booking_party_size BETWEEN 0 AND 20 AND max_booking_party_size BETWEEN 0 AND 20
  AND (max_booking_party_size = 0 OR max_booking_party_size >= greatest(1,min_booking_party_size))
);

-- All predicate inputs originate from trusted persisted offer rows, not client-supplied booking facts.
CREATE OR REPLACE FUNCTION public.booking_meets_activity_usage(
  p_booking_id uuid,p_member_id uuid,p_required_ids uuid[],p_match text,p_groups jsonb,
  p_amount_mode text,p_amount integer,p_amount_ids uuid[],p_min_party integer,p_max_party integer
) RETURNS boolean LANGUAGE sql STABLE SET search_path TO '' AS $fn$
  select coalesce((select
    (coalesce(p_min_party,0)=0 OR b.party_size>=p_min_party)
    AND (coalesce(p_max_party,0)=0 OR b.party_size<=p_max_party)
    AND public.booking_meets_required_services(b.id,coalesce(p_required_ids,'{}'::uuid[]),coalesce(p_match,'any'),coalesce(p_groups,'[]'::jsonb))
    AND (coalesce(p_amount_mode,'none')='none' OR
      (select coalesce(sum(bi.unit_price_amount::bigint*bi.quantity::bigint),0)
       from public.booking_items bi where bi.booking_id=b.id
       and (p_amount_mode='total' OR bi.service_id=any(coalesce(p_amount_ids,'{}'::uuid[])))) >= coalesce(p_amount,0))
  from public.bookings b where b.id=p_booking_id AND b.member_id=p_member_id),false);
$fn$;

CREATE OR REPLACE FUNCTION public.booking_ticket_matches_services(p_booking_id uuid, p_member_id uuid, p_kind text, p_ref text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce((
    select public.booking_meets_required_services(p_booking_id,coalesce(r.required_service_ids,'{}'::uuid[]),coalesce(r.required_service_match_mode,'any'),coalesce(r.required_service_groups,'[]'::jsonb))
    from public.point_tickets pt left join public.point_card_rewards r on r.id=pt.reward_id
    where p_kind='points' and pt.member_id=p_member_id and pt.ticket_id=p_ref
    union all
    select public.booking_meets_required_services(p_booking_id,et.required_service_ids,et.required_service_match_mode,coalesce(et.required_service_groups,'[]'::jsonb))
      and exists(select 1 from public.bookings b where b.id=p_booking_id and b.member_id=p_member_id
        and (et.min_booking_party_size=0 or b.party_size>=et.min_booking_party_size)
        and (et.max_booking_party_size=0 or b.party_size<=et.max_booking_party_size))
    from public.event_ticket_claims ec join public.event_tickets et on et.id=ec.event_ticket_id
    where p_kind='event' and ec.member_id=p_member_id and ec.claim_id=p_ref
  ),false);
$function$
;

CREATE OR REPLACE FUNCTION public.ticket_has_service_requirement(p_member uuid, p_kind text, p_ref text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select coalesce((select (cardinality(coalesce(r.required_service_ids,'{}'::uuid[]))>0 or jsonb_array_length(coalesce(r.required_service_groups,'[]'::jsonb))>0)
 from public.point_tickets t left join public.point_card_rewards r on r.id=t.reward_id
 where p_kind='points' and t.member_id=p_member and t.ticket_id=p_ref
 union all select (cardinality(e.required_service_ids)>0 or jsonb_array_length(coalesce(e.required_service_groups,'[]'::jsonb))>0 or e.min_booking_party_size>0 or e.max_booking_party_size>0) from public.event_ticket_claims c
 join public.event_tickets e on e.id=c.event_ticket_id
 where p_kind='event' and c.member_id=p_member and c.claim_id=p_ref),true);
$function$
;

CREATE OR REPLACE FUNCTION public.apply_calendar_batch(p_actor_line_user_id text, p_operations jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_op jsonb;
  v_item jsonb;
  v_action text;
  v_id text;
  v_expected timestamptz;
  v_result jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) < 1 or jsonb_array_length(p_operations) > 20 then
    raise exception 'INVALID_CALENDAR_BATCH';
  end if;

  for v_op in select value from jsonb_array_elements(p_operations)
  loop
    v_action := coalesce(nullif(v_op->>'action', ''), nullif(v_op->>'operation', ''), 'save');
    if v_action not in ('save', 'delete') then
      raise exception 'INVALID_CALENDAR_BATCH';
    end if;

    if v_action = 'delete' then
      v_id := coalesce(v_op->>'calendarItemId', v_op#>>'{calendarItem,calendarItemId}');
      v_expected := nullif(coalesce(v_op->>'expectedUpdatedAt', v_op#>>'{calendarItem,expectedUpdatedAt}'), '')::timestamptz;
      if not exists(select 1 from public.calendar_items where calendar_item_id = v_id for update) then
        raise exception 'CALENDAR_ITEM_NOT_FOUND';
      end if;
      if v_expected is not null and not exists(select 1 from public.calendar_items where calendar_item_id = v_id and updated_at = v_expected) then
        raise exception 'CONFLICT';
      end if;
    else
      v_item := coalesce(v_op->'calendarItem', v_op);
      v_id := nullif(v_item->>'calendarItemId', '');
      if v_id is not null then
        v_expected := nullif(coalesce(v_op->>'expectedUpdatedAt', v_item->>'expectedUpdatedAt'), '')::timestamptz;
        if not exists(select 1 from public.calendar_items where calendar_item_id = v_id for update) then
          raise exception 'CALENDAR_ITEM_NOT_FOUND';
        end if;
        if v_expected is not null and not exists(select 1 from public.calendar_items where calendar_item_id = v_id and updated_at = v_expected) then
          raise exception 'CONFLICT';
        end if;
      end if;
    end if;
  end loop;

  for v_op in select value from jsonb_array_elements(p_operations)
  loop
    v_action := coalesce(nullif(v_op->>'action', ''), nullif(v_op->>'operation', ''), 'save');
    if v_action = 'delete' then
      v_id := coalesce(v_op->>'calendarItemId', v_op#>>'{calendarItem,calendarItemId}');
      delete from public.calendar_items where calendar_item_id = v_id;
      v_result := v_result || jsonb_build_array(jsonb_build_object('action', 'delete', 'calendarItemId', v_id));
    else
      v_item := coalesce(v_op->'calendarItem', v_op);
      v_id := nullif(v_item->>'calendarItemId', '');
      if coalesce(nullif(v_item->>'visibilityPolicy', ''), 'eligible_only') not in ('eligible_only','higher_preview') then
        raise exception 'INVALID_VISIBILITY_POLICY';
      end if;
      if coalesce(v_item->>'itemType','')='event' then
        if (coalesce(v_item->>'minBookingPartySize','0') !~ '^(0|[1-9][0-9]?)
        insert into public.calendar_items(
          calendar_item_id, title, item_type, description, starts_on, ends_on, status, accent, allowed_tier_keys, visibility_policy, link_label, link_url, created_by, updated_by,
          required_service_ids,required_service_match_mode,required_service_groups,min_booking_amount_mode,min_booking_amount,min_booking_service_ids,min_booking_party_size,max_booking_party_size
        ) values(
          v_id, trim(v_item->>'title'), v_item->>'itemType', coalesce(v_item->>'description', ''), (v_item->>'startsOn')::date,
          nullif(v_item->>'endsOn', '')::date, v_item->>'status', v_item->>'accent',
          coalesce(array(select jsonb_array_elements_text(v_item->'allowedTierKeys')), array[]::text[]),
          coalesce(nullif(v_item->>'visibilityPolicy', ''), 'eligible_only'),
          coalesce(v_item->>'linkLabel', ''), coalesce(v_item->>'linkUrl', ''), p_actor_line_user_id, p_actor_line_user_id,
          array(select value::uuid from jsonb_array_elements_text(coalesce(v_item->'requiredServiceIds','[]'::jsonb)) value),
          coalesce(v_item->>'requiredServiceMatchMode','any'),coalesce(v_item->'requiredServiceGroups','[]'::jsonb),
          coalesce(v_item->>'minBookingAmountMode','none'),coalesce((v_item->>'minBookingAmount')::integer,0),
          array(select value::uuid from jsonb_array_elements_text(coalesce(v_item->'minBookingServiceIds','[]'::jsonb)) value),
          coalesce((v_item->>'minBookingPartySize')::smallint,0),coalesce((v_item->>'maxBookingPartySize')::smallint,0)
        );
      else
        update public.calendar_items set
          title = trim(v_item->>'title'),
          item_type = v_item->>'itemType',
          description = coalesce(v_item->>'description', ''),
          starts_on = (v_item->>'startsOn')::date,
          ends_on = nullif(v_item->>'endsOn', '')::date,
          status = v_item->>'status',
          accent = v_item->>'accent',
          allowed_tier_keys = coalesce(array(select jsonb_array_elements_text(v_item->'allowedTierKeys')), array[]::text[]),
          visibility_policy = coalesce(nullif(v_item->>'visibilityPolicy', ''), visibility_policy),
          link_label = coalesce(v_item->>'linkLabel', ''),
          link_url = coalesce(v_item->>'linkUrl', ''),
          required_service_ids = case when v_item ? 'requiredServiceIds' then array(select value::uuid from jsonb_array_elements_text(v_item->'requiredServiceIds') value) else required_service_ids end,
          required_service_match_mode = coalesce(v_item->>'requiredServiceMatchMode',required_service_match_mode),
          required_service_groups = coalesce(v_item->'requiredServiceGroups',required_service_groups),
          min_booking_amount_mode = coalesce(v_item->>'minBookingAmountMode',min_booking_amount_mode),
          min_booking_amount = coalesce((v_item->>'minBookingAmount')::integer,min_booking_amount),
          min_booking_service_ids = case when v_item ? 'minBookingServiceIds' then array(select value::uuid from jsonb_array_elements_text(v_item->'minBookingServiceIds') value) else min_booking_service_ids end,
          min_booking_party_size = coalesce((v_item->>'minBookingPartySize')::smallint,min_booking_party_size),
          max_booking_party_size = coalesce((v_item->>'maxBookingPartySize')::smallint,max_booking_party_size),
          updated_by = p_actor_line_user_id,
          updated_at = now()
        where calendar_item_id = v_id;
      end if;
      v_result := v_result || jsonb_build_array(jsonb_build_object('action', 'save', 'calendarItemId', v_id));
    end if;
  end loop;

  return v_result;
end;
$function$

            or coalesce(v_item->>'maxBookingPartySize','0') !~ '^(0|[1-9][0-9]?)
        insert into public.calendar_items(
          calendar_item_id, title, item_type, description, starts_on, ends_on, status, accent, allowed_tier_keys, visibility_policy, link_label, link_url, created_by, updated_by
        ) values(
          v_id, trim(v_item->>'title'), v_item->>'itemType', coalesce(v_item->>'description', ''), (v_item->>'startsOn')::date,
          nullif(v_item->>'endsOn', '')::date, v_item->>'status', v_item->>'accent',
          coalesce(array(select jsonb_array_elements_text(v_item->'allowedTierKeys')), array[]::text[]),
          coalesce(nullif(v_item->>'visibilityPolicy', ''), 'eligible_only'),
          coalesce(v_item->>'linkLabel', ''), coalesce(v_item->>'linkUrl', ''), p_actor_line_user_id, p_actor_line_user_id
        );
      else
        update public.calendar_items set
          title = trim(v_item->>'title'),
          item_type = v_item->>'itemType',
          description = coalesce(v_item->>'description', ''),
          starts_on = (v_item->>'startsOn')::date,
          ends_on = nullif(v_item->>'endsOn', '')::date,
          status = v_item->>'status',
          accent = v_item->>'accent',
          allowed_tier_keys = coalesce(array(select jsonb_array_elements_text(v_item->'allowedTierKeys')), array[]::text[]),
          visibility_policy = coalesce(nullif(v_item->>'visibilityPolicy', ''), visibility_policy),
          link_label = coalesce(v_item->>'linkLabel', ''),
          link_url = coalesce(v_item->>'linkUrl', ''),
          updated_by = p_actor_line_user_id,
          updated_at = now()
        where calendar_item_id = v_id;
      end if;
      v_result := v_result || jsonb_build_array(jsonb_build_object('action', 'save', 'calendarItemId', v_id));
    end if;
  end loop;

  return v_result;
end;
$function$

            or coalesce((v_item->>'minBookingPartySize')::int,0)>20
            or coalesce((v_item->>'maxBookingPartySize')::int,0)>20
            or (coalesce((v_item->>'maxBookingPartySize')::int,0)>0
                and coalesce((v_item->>'maxBookingPartySize')::int,0)<greatest(1,coalesce((v_item->>'minBookingPartySize')::int,0)))) then
          raise exception 'INVALID_BOOKING_PARTY_SIZE_RULE';
        end if;
        if coalesce(v_item->>'minBookingAmountMode','none') not in ('none','total','selected_services')
          or coalesce((v_item->>'minBookingAmount')::int,0)<0
          or (coalesce(v_item->>'minBookingAmountMode','none')='none' and coalesce((v_item->>'minBookingAmount')::int,0)<>0)
          or (coalesce(v_item->>'minBookingAmountMode','none')<>'none' and coalesce((v_item->>'minBookingAmount')::int,0)<1) then
          raise exception 'INVALID_BOOKING_AMOUNT_RULE';
        end if;
      end if;
      if v_id is null then
        v_id := public.new_public_id('CAL');
        insert into public.calendar_items(
          calendar_item_id, title, item_type, description, starts_on, ends_on, status, accent, allowed_tier_keys, visibility_policy, link_label, link_url, created_by, updated_by
        ) values(
          v_id, trim(v_item->>'title'), v_item->>'itemType', coalesce(v_item->>'description', ''), (v_item->>'startsOn')::date,
          nullif(v_item->>'endsOn', '')::date, v_item->>'status', v_item->>'accent',
          coalesce(array(select jsonb_array_elements_text(v_item->'allowedTierKeys')), array[]::text[]),
          coalesce(nullif(v_item->>'visibilityPolicy', ''), 'eligible_only'),
          coalesce(v_item->>'linkLabel', ''), coalesce(v_item->>'linkUrl', ''), p_actor_line_user_id, p_actor_line_user_id
        );
      else
        update public.calendar_items set
          title = trim(v_item->>'title'),
          item_type = v_item->>'itemType',
          description = coalesce(v_item->>'description', ''),
          starts_on = (v_item->>'startsOn')::date,
          ends_on = nullif(v_item->>'endsOn', '')::date,
          status = v_item->>'status',
          accent = v_item->>'accent',
          allowed_tier_keys = coalesce(array(select jsonb_array_elements_text(v_item->'allowedTierKeys')), array[]::text[]),
          visibility_policy = coalesce(nullif(v_item->>'visibilityPolicy', ''), visibility_policy),
          link_label = coalesce(v_item->>'linkLabel', ''),
          link_url = coalesce(v_item->>'linkUrl', ''),
          updated_by = p_actor_line_user_id,
          updated_at = now()
        where calendar_item_id = v_id;
      end if;
      v_result := v_result || jsonb_build_array(jsonb_build_object('action', 'save', 'calendarItemId', v_id));
    end if;
  end loop;

  return v_result;
end;
$function$
;

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
BEGIN
  PERFORM public.booking_price_context_time();
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
      if v_event.starts_on is not null and v_today < v_event.starts_on then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
      if v_event.ends_on is not null and v_today > v_event.ends_on then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
      if coalesce(cardinality(v_event.allowed_tier_keys),0) > 0
        and not coalesce(public.tier_allows(v_tier,v_event.allowed_tier_keys),false)
        and not exists (select 1 from public.event_ticket_transfers t
          where t.claim_id = v_ref and t.receiver_member_id = p_member_id)
      then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;
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
         and not (public.tier_allows(v_tier,v_calendar.allowed_tier_keys)) then
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
      if not public.booking_meets_activity_usage(p_booking_id,p_member_id,
        v_calendar.required_service_ids,v_calendar.required_service_match_mode,v_calendar.required_service_groups,
        v_calendar.min_booking_amount_mode,v_calendar.min_booking_amount,v_calendar.min_booking_service_ids,
        v_calendar.min_booking_party_size,v_calendar.max_booking_party_size) then
        raise exception 'BOOKING_ACTIVITY_REQUIREMENT_NOT_MET';
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
$function$
;

CREATE OR REPLACE FUNCTION public.validate_booking_benefit_service_requirement_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_required uuid[] := '{}'::uuid[];
  v_match_mode text := 'any';
  v_groups jsonb := '[]'::jsonb;
  v_titles text[] := '{}'::text[];
begin
  if new.status = 'cancelled' then return new; end if;
  if new.benefit_kind = 'calendar' then
    if not exists (select 1 from public.calendar_items ci where ci.calendar_item_id=new.benefit_ref
      and ci.item_type='event'
      and public.booking_meets_activity_usage(new.booking_id,new.member_id,
        ci.required_service_ids,ci.required_service_match_mode,ci.required_service_groups,
        ci.min_booking_amount_mode,ci.min_booking_amount,ci.min_booking_service_ids,
        ci.min_booking_party_size,ci.max_booking_party_size)) then
      raise exception 'BOOKING_ACTIVITY_REQUIREMENT_NOT_MET';
    end if;
    return new;
  end if;

  if new.benefit_kind = 'points' then
    select coalesce(r.required_service_ids, '{}'::uuid[]),
           coalesce(r.required_service_match_mode, 'any'), coalesce(r.required_service_groups,'[]'::jsonb)
      into v_required, v_match_mode, v_groups
    from public.point_tickets pt
    join public.point_card_rewards r on r.id = pt.reward_id
    where pt.ticket_id = new.benefit_ref;
  elsif new.benefit_kind = 'event' then
    select coalesce(et.required_service_ids, '{}'::uuid[]),
           coalesce(et.required_service_match_mode, 'any'), coalesce(et.required_service_groups,'[]'::jsonb)
      into v_required, v_match_mode, v_groups
    from public.event_ticket_claims ec
    join public.event_tickets et on et.id = ec.event_ticket_id
    where ec.claim_id = new.benefit_ref;
  end if;

  v_required := coalesce(v_required, '{}'::uuid[]);
  v_match_mode := case when v_match_mode = 'all' then 'all' else 'any' end;

  if new.benefit_kind='event' and not public.booking_ticket_matches_services(new.booking_id,new.member_id,'event',new.benefit_ref) then
    raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED';
  end if;
  if (cardinality(v_required) > 0 or jsonb_array_length(coalesce(v_groups,'[]'::jsonb)) > 0)
     and not public.booking_meets_required_services(new.booking_id, v_required, v_match_mode, v_groups) then
    v_titles := public.required_booking_service_titles(v_required);
    raise exception 'BOOKING_BENEFIT_SERVICE_REQUIRED'
      using detail = format(
        case when v_match_mode = 'all'
          then '票券「%s」需預約所有指定項目：%s'
          else '票券「%s」需預約以下任一項目：%s'
        end,
        coalesce(nullif(new.title_snapshot, ''), new.benefit_ref),
        array_to_string(v_titles, '、')
      );
  end if;

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reconcile_booking_ticket_services(p_booking_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_booking public.bookings%rowtype; v_removed jsonb;
BEGIN
  PERFORM public.booking_price_context_time();
  select * into v_booking from public.bookings where id=p_booking_id for update;
  if not found or v_booking.status not in ('pending','confirmed') then return; end if;
  if exists(select 1 from public.booking_benefit_selections s where s.booking_id=p_booking_id
    and s.status='redeemed' and s.benefit_kind in ('points','event')
    and (not public.booking_ticket_matches_services(p_booking_id,s.member_id,s.benefit_kind,s.benefit_ref) or (s.benefit_kind='event' and v_booking.receipt_submission_id is null and not exists(select 1 from public.booking_receipts r where r.booking_id=p_booking_id) and not public.booking_ticket_meets_amount(p_booking_id,s.member_id,s.benefit_kind,s.benefit_ref)))) then
    raise exception 'BOOKING_REDEEMED_BENEFIT_SERVICE_REQUIRED';
  end if;
  with removed as (
    update public.booking_benefit_selections s set status='cancelled',result=jsonb_build_object('cancellationReason','booking_services_changed')
    where s.booking_id=p_booking_id and s.status='pending' and s.benefit_kind in ('points','event')
      and (not public.booking_ticket_matches_services(p_booking_id,s.member_id,s.benefit_kind,s.benefit_ref) or (s.benefit_kind='event' and v_booking.receipt_submission_id is null and not exists(select 1 from public.booking_receipts r where r.booking_id=p_booking_id) and not public.booking_ticket_meets_amount(p_booking_id,s.member_id,s.benefit_kind,s.benefit_ref)))
    returning s.benefit_kind,s.benefit_ref,s.title_snapshot
  ) select jsonb_agg(jsonb_build_object('kind',benefit_kind,'id',benefit_ref,'title',title_snapshot)) into v_removed from removed;
  -- An activity already selected for this booking must not silently remain valid after item changes.
  if exists (select 1 from public.booking_benefit_selections s
     join public.calendar_items ci on ci.calendar_item_id=s.benefit_ref
     where s.booking_id=p_booking_id and s.benefit_kind='calendar' and s.status='redeemed'
       and not public.booking_meets_activity_usage(p_booking_id,s.member_id,
         ci.required_service_ids,ci.required_service_match_mode,ci.required_service_groups,
         ci.min_booking_amount_mode,ci.min_booking_amount,ci.min_booking_service_ids,
         ci.min_booking_party_size,ci.max_booking_party_size)) then
    raise exception 'BOOKING_ACTIVITY_REQUIREMENT_NOT_MET';
  end if;
  update public.booking_benefit_selections s set status='cancelled',
    result=jsonb_build_object('cancellationReason','booking_conditions_changed')
    from public.calendar_items ci
    where s.booking_id=p_booking_id and s.benefit_kind='calendar' and s.status='pending'
      and ci.calendar_item_id=s.benefit_ref
      and not public.booking_meets_activity_usage(p_booking_id,s.member_id,
        ci.required_service_ids,ci.required_service_match_mode,ci.required_service_groups,
        ci.min_booking_amount_mode,ci.min_booking_amount,ci.min_booking_service_ids,
        ci.min_booking_party_size,ci.max_booking_party_size);
  if v_removed is not null then
    insert into public.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
    values(coalesce(nullif(current_setting('app.booking_actor',true),''),'system'),'system','BOOKING_TICKETS_RELEASED','booking',p_booking_id::text,'success',
      jsonb_build_object('reason','booking_services_changed','selections',v_removed));
  end if;
end;
$function$
;

-- Protect existing reservations when party size is changed after benefit selection.
CREATE OR REPLACE FUNCTION public.guard_booking_party_size_benefits() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $guard$
BEGIN
 IF EXISTS (SELECT 1 FROM public.booking_benefit_selections s
   LEFT JOIN public.event_ticket_claims claim ON s.benefit_kind='event' AND s.benefit_ref=claim.claim_id AND s.member_id=claim.member_id
   LEFT JOIN public.event_tickets et ON et.id=claim.event_ticket_id
   LEFT JOIN public.calendar_items ci ON s.benefit_kind='calendar' AND ci.calendar_item_id=s.benefit_ref
   WHERE s.booking_id=NEW.id AND s.status IN ('pending','redeemed') AND (
    (s.benefit_kind='event' AND (et.id IS NULL OR
      (et.min_booking_party_size>0 AND NEW.party_size<et.min_booking_party_size) OR
      (et.max_booking_party_size>0 AND NEW.party_size>et.max_booking_party_size)))
    OR (s.benefit_kind='calendar' AND (ci.id IS NULL OR
      (ci.min_booking_party_size>0 AND NEW.party_size<ci.min_booking_party_size) OR
      (ci.max_booking_party_size>0 AND NEW.party_size>ci.max_booking_party_size)))
   )) THEN RAISE EXCEPTION 'BOOKING_BENEFIT_PARTY_SIZE_REQUIRED'; END IF;
 RETURN NEW;
END; $guard$;
CREATE TRIGGER booking_party_size_benefits_guard BEFORE UPDATE OF party_size ON public.bookings
 FOR EACH ROW WHEN (OLD.party_size IS DISTINCT FROM NEW.party_size) EXECUTE FUNCTION public.guard_booking_party_size_benefits();
