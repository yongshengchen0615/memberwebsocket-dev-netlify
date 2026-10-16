-- One physical event ticket claim may be reserved by only one active source.
-- Booking selections and snapshot receipts use different storage; protect both
-- writes using the same locked claim row to serialize concurrent registrations.
do $check$
begin
  if exists (
    select 1 from public.booking_receipts r
    cross join lateral jsonb_array_elements(coalesce(r.requested_benefits,'[]'::jsonb)) AS entry(value)
    where r.submission_mode='accessible' and r.status in ('pending_upload','awaiting_review')
      and entry.value->>'kind'='event'
    group by r.member_id,entry.value->>'id'
    having count(*) > 1
  ) or exists (
    select 1 from public.booking_receipts r
    cross join lateral jsonb_array_elements(coalesce(r.requested_benefits,'[]'::jsonb)) AS entry(value)
    join public.booking_benefit_selections s
      on s.member_id=r.member_id and s.benefit_kind='event'
     and s.benefit_ref=entry.value->>'id' and s.status='pending'
    where r.submission_mode='accessible' and r.status in ('pending_upload','awaiting_review')
      and entry.value->>'kind'='event'
  ) then
    raise exception 'EXISTING_EVENT_TICKET_RESERVATION_CONFLICT';
  end if;
end;
$check$;

create or replace function public.guard_general_event_ticket_cross_mode()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.benefit_kind='event' and new.status='pending' then
    -- A shared row lock serializes the general and snapshot entrypoints.
    perform 1 from public.event_ticket_claims c
      where c.member_id=new.member_id and c.claim_id=new.benefit_ref
      for update;
    if not found then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;

    if exists (
      select 1 from public.booking_receipts r
      where r.member_id=new.member_id
        and r.submission_mode='accessible'
        and r.status in ('pending_upload','awaiting_review')
        -- Admin snapshot settlement transfers its OWN receipt selection into
        -- the generated booking before the receipt transitions to bound.
        and r.receipt_id is distinct from nullif(current_setting('app.snapshot_receipt_id',true),'')
        and r.requested_benefits @> jsonb_build_array(
          jsonb_build_object('kind','event','id',new.benefit_ref)
        )
    ) then raise exception 'EVENT_TICKET_ALREADY_REGISTERED'; end if;
  end if;
  return new;
end;
$function$;

create or replace function public.guard_snapshot_event_ticket_cross_mode()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_claim_id text;
begin
  if new.submission_mode <> 'accessible'
     or new.status not in ('pending_upload','awaiting_review') then
    return new;
  end if;
  if jsonb_typeof(coalesce(new.requested_benefits,'[]'::jsonb)) <> 'array'
    then raise exception 'INVALID_BOOKING_BENEFITS'; end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(new.requested_benefits,'[]'::jsonb)) AS item(value)
    where item.value->>'kind'='event'
    group by item.value->>'id' having count(*) > 1
  ) then raise exception 'INVALID_BOOKING_BENEFITS'; end if;

  for v_claim_id in
    select distinct item.value->>'id' as ref
    from jsonb_array_elements(coalesce(new.requested_benefits,'[]'::jsonb)) AS item(value)
    where item.value->>'kind'='event'
    order by ref
  loop
    -- Lock before reading either reservation surface (no check/write race).
    perform 1 from public.event_ticket_claims c
      where c.member_id=new.member_id and c.claim_id=v_claim_id for update;
    if not found then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'; end if;

    if exists (
      select 1 from public.booking_benefit_selections s
      where s.member_id=new.member_id and s.benefit_kind='event'
        and s.benefit_ref=v_claim_id and s.status='pending'
    ) or exists (
      select 1 from public.booking_receipts r
      where r.member_id=new.member_id and r.id<>new.id
        and r.submission_mode='accessible'
        and r.status in ('pending_upload','awaiting_review')
        and r.requested_benefits @> jsonb_build_array(
          jsonb_build_object('kind','event','id',v_claim_id)
        )
    ) then raise exception 'EVENT_TICKET_ALREADY_REGISTERED'; end if;
  end loop;
  return new;
end;
$function$;

drop trigger if exists general_event_ticket_cross_mode_guard on public.booking_benefit_selections;
create trigger general_event_ticket_cross_mode_guard
before insert or update of member_id,benefit_kind,benefit_ref,status
on public.booking_benefit_selections
for each row execute function public.guard_general_event_ticket_cross_mode();

drop trigger if exists snapshot_event_ticket_cross_mode_guard on public.booking_receipts;
create trigger snapshot_event_ticket_cross_mode_guard
before insert or update of member_id,submission_mode,status,requested_benefits
on public.booking_receipts
for each row execute function public.guard_snapshot_event_ticket_cross_mode();

revoke all on function public.guard_general_event_ticket_cross_mode() from public,anon,authenticated;
revoke all on function public.guard_snapshot_event_ticket_cross_mode() from public,anon,authenticated;
