-- Booking benefit selection + atomic completion redemption.
-- Selection records usage intent only; consumable tickets are redeemed when an authorized admin completes the booking.

create table if not exists public.booking_benefit_selections (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  benefit_kind text not null check (benefit_kind in ('points','event','calendar')),
  benefit_ref text not null,
  title_snapshot text not null default '',
  status text not null default 'pending' check (status in ('pending','redeemed','applied','cancelled')),
  selected_at timestamptz not null default now(),
  redeemed_at timestamptz,
  redeemed_by text,
  result jsonb,
  unique (booking_id, benefit_kind, benefit_ref)
);

create index if not exists booking_benefit_selections_member_status_idx
  on public.booking_benefit_selections(member_id,status,selected_at desc);
create index if not exists booking_benefit_selections_booking_status_idx
  on public.booking_benefit_selections(booking_id,status);

alter table public.booking_benefit_selections enable row level security;
revoke all on table public.booking_benefit_selections from anon, authenticated;
grant all on table public.booking_benefit_selections to service_role;

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
      v_title := coalesce(v_point.ticket_title,'集點卡票券');

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

revoke all on function public.replace_booking_benefit_selections_request(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.replace_booking_benefit_selections_request(uuid,uuid,jsonb) to service_role;

create or replace function public.create_booking_bundle_with_benefits_request(
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time without time zone,
  p_items jsonb,
  p_member_note text,
  p_benefits jsonb default '[]'::jsonb
)
returns public.bookings
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_booking public.bookings%rowtype;
begin
  select * into v_booking
  from public.create_booking_bundle_request(
    p_request_id,p_member_id,p_booking_date,p_start_time,p_items,p_member_note
  );
  perform public.replace_booking_benefit_selections_request(v_booking.id,p_member_id,p_benefits);
  return v_booking;
end;
$function$;

create or replace function public.update_booking_bundle_with_benefits_request(
  p_booking_id uuid,
  p_expected_updated_at timestamptz,
  p_actor text,
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time without time zone,
  p_items jsonb,
  p_member_note text,
  p_benefits jsonb default '[]'::jsonb
)
returns public.bookings
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_booking public.bookings%rowtype;
begin
  select * into v_booking
  from public.update_booking_bundle_request(
    p_booking_id,p_expected_updated_at,p_actor,p_request_id,p_member_id,
    p_booking_date,p_start_time,p_items,p_member_note
  );
  perform public.replace_booking_benefit_selections_request(v_booking.id,p_member_id,p_benefits);
  return v_booking;
end;
$function$;

create or replace function public.create_group_booking_with_benefits_request_v2(
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time without time zone,
  p_participants jsonb,
  p_member_note text,
  p_contact_source text,
  p_contact_surname text,
  p_contact_salutation text,
  p_contact_phone text,
  p_benefits jsonb default '[]'::jsonb
)
returns public.bookings
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_booking public.bookings%rowtype;
begin
  select * into v_booking
  from public.create_group_booking_request_v2(
    p_request_id,p_member_id,p_booking_date,p_start_time,p_participants,p_member_note,
    p_contact_source,p_contact_surname,p_contact_salutation,p_contact_phone
  );
  perform public.replace_booking_benefit_selections_request(v_booking.id,p_member_id,p_benefits);
  return v_booking;
end;
$function$;

create or replace function public.update_group_booking_with_benefits_request_v2(
  p_booking_id uuid,
  p_expected_updated_at timestamptz,
  p_actor text,
  p_request_id text,
  p_member_id uuid,
  p_booking_date date,
  p_start_time time without time zone,
  p_participants jsonb,
  p_member_note text,
  p_contact_source text,
  p_contact_surname text,
  p_contact_salutation text,
  p_contact_phone text,
  p_benefits jsonb default '[]'::jsonb
)
returns public.bookings
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_booking public.bookings%rowtype;
begin
  select * into v_booking
  from public.update_group_booking_request_v2(
    p_booking_id,p_expected_updated_at,p_actor,p_request_id,p_member_id,p_booking_date,p_start_time,
    p_participants,p_member_note,p_contact_source,p_contact_surname,p_contact_salutation,p_contact_phone
  );
  perform public.replace_booking_benefit_selections_request(v_booking.id,p_member_id,p_benefits);
  return v_booking;
end;
$function$;

revoke all on function public.create_booking_bundle_with_benefits_request(text,uuid,date,time without time zone,jsonb,text,jsonb) from public, anon, authenticated;
revoke all on function public.update_booking_bundle_with_benefits_request(uuid,timestamptz,text,text,uuid,date,time without time zone,jsonb,text,jsonb) from public, anon, authenticated;
revoke all on function public.create_group_booking_with_benefits_request_v2(text,uuid,date,time without time zone,jsonb,text,text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.update_group_booking_with_benefits_request_v2(uuid,timestamptz,text,text,uuid,date,time without time zone,jsonb,text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.create_booking_bundle_with_benefits_request(text,uuid,date,time without time zone,jsonb,text,jsonb) to service_role;
grant execute on function public.update_booking_bundle_with_benefits_request(uuid,timestamptz,text,text,uuid,date,time without time zone,jsonb,text,jsonb) to service_role;
grant execute on function public.create_group_booking_with_benefits_request_v2(text,uuid,date,time without time zone,jsonb,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.update_group_booking_with_benefits_request_v2(uuid,timestamptz,text,text,uuid,date,time without time zone,jsonb,text,text,text,text,text,jsonb) to service_role;

create or replace function public.complete_booking_with_benefits_request(
  p_booking_id uuid,
  p_expected_updated_at timestamptz,
  p_actor text,
  p_admin_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_booking public.bookings%rowtype;
  v_member public.members%rowtype;
  v_selection public.booking_benefit_selections%rowtype;
  v_calendar public.calendar_items%rowtype;
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

  select array_agg(benefit_ref order by benefit_ref) into v_point_ids
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
      select 1
      from public.point_tickets pt
      where pt.member_id=v_booking.member_id
        and pt.ticket_id=any(v_point_ids)
        and coalesce(pt.requires_location,false)
    ) then
      raise exception 'BOOKING_BENEFIT_LOCATION_REQUIRED';
    end if;

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

  update public.booking_benefit_selections
  set status='redeemed',redeemed_at=now(),redeemed_by=p_actor,result=v_point_result
  where booking_id=p_booking_id and status='pending' and benefit_kind='points';

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

revoke all on function public.complete_booking_with_benefits_request(uuid,timestamptz,text,text) from public, anon, authenticated;
grant execute on function public.complete_booking_with_benefits_request(uuid,timestamptz,text,text) to service_role;

create or replace function public.cancel_booking_benefit_selections_on_terminal_status()
returns trigger
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
begin
  if new.status in ('cancelled','rejected') and old.status is distinct from new.status then
    update public.booking_benefit_selections
    set status='cancelled'
    where booking_id=new.id and status='pending';
  end if;
  return new;
end;
$function$;

drop trigger if exists booking_benefit_selections_terminal_status on public.bookings;
create trigger booking_benefit_selections_terminal_status
after update of status on public.bookings
for each row execute function public.cancel_booking_benefit_selections_on_terminal_status();

create or replace function public.admin_confirm_booking_receipt_request(
  p_booking_id uuid,
  p_expected_booking_updated_at timestamptz,
  p_actor_line_user_id text,
  p_admin_note text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_booking public.bookings%rowtype;
  v_receipt public.booking_receipts%rowtype;
  v_settlement jsonb;
begin
  select * into v_booking
  from public.bookings
  where id=p_booking_id
  for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;

  if v_booking.status='completed' then
    select * into v_receipt
    from public.booking_receipts
    where booking_id=p_booking_id and status='bound'
    order by bound_at desc nulls last, created_at desc
    limit 1;
    select jsonb_build_object(
      'bookingId',s.booking_id,
      'serviceMinutes',s.service_minutes,
      'rewards',s.reward_details
    ) into v_settlement
    from public.booking_completion_settlements s
    where s.booking_id=p_booking_id;
    return jsonb_build_object(
      'receiptId',coalesce(v_receipt.receipt_id,''),
      'bookingId',p_booking_id,
      'status','bound',
      'settlement',coalesce(v_settlement,'{}'::jsonb),
      'alreadyApplied',true
    );
  end if;

  if v_booking.status<>'confirmed' then raise exception 'INVALID_BOOKING_TRANSITION'; end if;
  if v_booking.cancellation_requested_at is not null and v_booking.cancellation_reviewed_at is null then
    raise exception 'BOOKING_CANCELLATION_PENDING';
  end if;
  if p_expected_booking_updated_at is null or v_booking.updated_at<>p_expected_booking_updated_at then
    raise exception 'BOOKING_CONFLICT';
  end if;

  select * into v_receipt
  from public.booking_receipts
  where booking_id=p_booking_id and status='awaiting_review'
  order by created_at desc
  limit 1
  for update;
  if not found then raise exception 'RECEIPT_AWAITING_REVIEW_REQUIRED'; end if;

  v_settlement:=public.complete_booking_with_benefits_request(
    p_booking_id,
    p_expected_booking_updated_at,
    p_actor_line_user_id,
    left(coalesce(p_admin_note,''),500)
  );

  update public.booking_receipts
  set status='bound',
      bound_at=now(),
      failure_reason='',
      updated_at=now()
  where id=v_receipt.id;

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values(
    public.new_public_id('AUD'),p_actor_line_user_id,'admin','admin.booking.receipt.confirm',
    'booking',p_booking_id::text,'success',
    jsonb_build_object(
      'receiptId',v_receipt.receipt_id,
      'objectPath',v_receipt.object_path,
      'previousReceiptStatus','awaiting_review',
      'nextReceiptStatus','bound'
    )
  );

  return jsonb_build_object(
    'receiptId',v_receipt.receipt_id,
    'bookingId',p_booking_id,
    'status','bound',
    'settlement',v_settlement,
    'alreadyApplied',false
  );
end;
$function$;
