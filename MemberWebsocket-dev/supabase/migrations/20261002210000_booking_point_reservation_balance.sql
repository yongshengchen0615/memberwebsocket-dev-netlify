create or replace function public.validate_booking_point_ticket_balance()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_point_card_id uuid;
  v_threshold integer := 0;
  v_balance integer := 0;
  v_existing_required integer := 0;
  v_exclude_selection_id uuid := null;
begin
  if new.benefit_kind <> 'points' or new.status <> 'pending' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_exclude_selection_id := old.id;
  end if;

  select pt.point_card_id, pt.threshold_stamps
    into v_point_card_id, v_threshold
  from public.point_tickets pt
  where pt.member_id = new.member_id
    and pt.ticket_id = new.benefit_ref
    and pt.status = 'available';

  if not found then
    return new;
  end if;

  select pb.stamps
    into v_balance
  from public.point_balances pb
  where pb.member_id = new.member_id
    and pb.point_card_id = v_point_card_id
  for update;

  v_balance := coalesce(v_balance, 0);

  select coalesce(sum(pt.threshold_stamps), 0)::integer
    into v_existing_required
  from public.booking_benefit_selections b
  join public.point_tickets pt
    on pt.member_id = b.member_id
   and pt.ticket_id = b.benefit_ref
  where b.member_id = new.member_id
    and b.benefit_kind = 'points'
    and b.status = 'pending'
    and pt.point_card_id = v_point_card_id
    and (v_exclude_selection_id is null or b.id <> v_exclude_selection_id);

  if v_existing_required + coalesce(v_threshold, 0) > v_balance then
    raise exception 'POINT_TICKET_INSUFFICIENT_POINTS';
  end if;

  return new;
end;
$function$;

drop trigger if exists booking_point_ticket_balance_guard
on public.booking_benefit_selections;

create trigger booking_point_ticket_balance_guard
before insert or update of member_id, benefit_kind, benefit_ref, status
on public.booking_benefit_selections
for each row
execute function public.validate_booking_point_ticket_balance();

create or replace function public.protect_booking_reserved_point_balance()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_reserved_points integer := 0;
begin
  select coalesce(sum(pt.threshold_stamps), 0)::integer
    into v_reserved_points
  from public.booking_benefit_selections b
  join public.point_tickets pt
    on pt.member_id = b.member_id
   and pt.ticket_id = b.benefit_ref
  where b.member_id = new.member_id
    and b.benefit_kind = 'points'
    and b.status = 'pending'
    and pt.point_card_id = new.point_card_id;

  if coalesce(new.stamps, 0) < v_reserved_points
     and (
       tg_op = 'INSERT'
       or coalesce(new.stamps, 0) < coalesce(old.stamps, 0)
     ) then
    raise exception 'INSUFFICIENT_POINTS';
  end if;

  return new;
end;
$function$;

drop trigger if exists point_balances_booking_reservation_guard
on public.point_balances;

create trigger point_balances_booking_reservation_guard
before insert or update of member_id, point_card_id, stamps
on public.point_balances
for each row
execute function public.protect_booking_reserved_point_balance();

create or replace function public.complete_booking_with_benefits_request(
  p_booking_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_actor text,
  p_admin_note text default ''::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
  select * into v_booking from public.bookings where id=p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if p_expected_updated_at is null or v_booking.updated_at <> p_expected_updated_at then raise exception 'BOOKING_CONFLICT'; end if;
  if v_booking.cancellation_requested_at is not null and v_booking.cancellation_reviewed_at is null then raise exception 'BOOKING_CANCELLATION_PENDING'; end if;
  if v_booking.status <> 'confirmed' then raise exception 'INVALID_BOOKING_TRANSITION'; end if;

  select * into v_member from public.members where id=v_booking.member_id for update;
  if not found or v_member.membership_status <> 'active' or v_member.status <> 'active' then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select array_agg(id order by benefit_ref), array_agg(benefit_ref order by benefit_ref)
    into v_point_selection_ids, v_point_ids
  from public.booking_benefit_selections
  where booking_id=p_booking_id and status='pending' and benefit_kind='points';

  select array_agg(benefit_ref order by benefit_ref) into v_event_ids
  from public.booking_benefit_selections
  where booking_id=p_booking_id and status='pending' and benefit_kind='event';

  v_tier := public.current_tier_key(v_booking.member_id);
  for v_selection in
    select * from public.booking_benefit_selections
    where booking_id=p_booking_id and status='pending' and benefit_kind='calendar'
    order by benefit_ref
    for update
  loop
    select * into v_calendar
    from public.calendar_items
    where calendar_item_id=v_selection.benefit_ref and item_type='event';

    if not found
       or v_calendar.starts_on > v_booking.booking_date
       or coalesce(v_calendar.ends_on,v_calendar.starts_on) < v_booking.booking_date
       or (cardinality(v_calendar.allowed_tier_keys) > 0 and not (v_tier = any(v_calendar.allowed_tier_keys))) then
      raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
    end if;
    if coalesce(v_calendar.audience_type,'all')='birthday_month' then
      if v_calendar.status <> 'targeted'
         or v_member.birthday is null
         or extract(month from v_member.birthday)::int <> v_calendar.audience_month then
        raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
      end if;
    elsif v_calendar.status <> 'active' then
      raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE';
    end if;
  end loop;

  if coalesce(cardinality(v_point_ids),0) > 0 then
    if exists (
      select 1 from public.point_tickets pt
      where pt.member_id=v_booking.member_id
        and pt.ticket_id=any(v_point_ids)
        and coalesce(pt.requires_location,false)
    ) then
      raise exception 'BOOKING_BENEFIT_LOCATION_REQUIRED';
    end if;

    update public.booking_benefit_selections
    set status='redeemed'
    where id=any(v_point_selection_ids)
      and status='pending'
      and benefit_kind='points';

    v_point_result := public.redeem_point_tickets(
      v_member.line_user_id,
      v_point_ids,
      'BOOKING_POINT_' || replace(p_booking_id::text,'-','')
    );
  end if;

  if coalesce(cardinality(v_event_ids),0) > 0 then
    v_event_result := public.redeem_event_tickets_with_location(
      v_member.line_user_id,
      v_event_ids,
      'BOOKING_EVENT_' || replace(p_booking_id::text,'-',''),
      null
    );
  end if;

  v_settlement := public.complete_booking_with_rewards_request(
    p_booking_id,p_expected_updated_at,p_actor,left(coalesce(p_admin_note,''),500)
  );

  if coalesce(cardinality(v_point_selection_ids),0) > 0 then
    update public.booking_benefit_selections
    set redeemed_at=now(),redeemed_by=p_actor,result=v_point_result
    where id=any(v_point_selection_ids)
      and status='redeemed'
      and benefit_kind='points';
  end if;

  update public.booking_benefit_selections
  set status='redeemed',redeemed_at=now(),redeemed_by=p_actor,result=v_event_result
  where booking_id=p_booking_id and status='pending' and benefit_kind='event';

  update public.booking_benefit_selections
  set status='applied',redeemed_at=now(),redeemed_by=p_actor,result=jsonb_build_object('activityApplied',true)
  where booking_id=p_booking_id and status='pending' and benefit_kind='calendar';

  select coalesce(jsonb_agg(jsonb_build_object(
    'kind',benefit_kind,
    'id',benefit_ref,
    'title',title_snapshot,
    'status',status,
    'result',result
  ) order by selected_at,id),'[]'::jsonb)
  into v_redemptions
  from public.booking_benefit_selections
  where booking_id=p_booking_id and status in ('redeemed','applied');

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values (
    public.new_public_id('AUD'),p_actor,'admin','admin.booking.benefits.redeem',
    'booking',p_booking_id::text,'success',
    jsonb_build_object('redemptions',v_redemptions)
  );

  return coalesce(v_settlement,'{}'::jsonb) || jsonb_build_object('redemptions',v_redemptions);
end;
$function$;
