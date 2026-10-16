-- Preserve the point-card source inside booking history.
-- Historical booking records must not change when a point card is renamed later.

create or replace function public.replace_booking_benefit_selections_request(
  p_booking_id uuid,
  p_member_id uuid,
  p_selections jsonb
)
returns void
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
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
      if coalesce(v_point.requires_location,false) then
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
      if coalesce(v_event.requires_location,false) then
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
    );
  end loop;
end;
$function$;

-- Backfill any existing point-ticket selections with the same immutable display snapshot.
update public.booking_benefit_selections b
set title_snapshot = left(
  concat_ws(
    '｜',
    nullif(btrim(pc.title),''),
    coalesce(
      nullif(btrim(pt.ticket_title),''),
      nullif(btrim(b.title_snapshot),''),
      '集點卡票券'
    )
  ),
  200
)
from public.point_tickets pt
join public.point_cards pc on pc.id = pt.point_card_id
where b.benefit_kind = 'points'
  and b.member_id = pt.member_id
  and b.benefit_ref = pt.ticket_id
  and b.title_snapshot is distinct from left(
    concat_ws(
      '｜',
      nullif(btrim(pc.title),''),
      coalesce(
        nullif(btrim(pt.ticket_title),''),
        nullif(btrim(b.title_snapshot),''),
        '集點卡票券'
      )
    ),
    200
  );
