-- Prevent booking point-ticket selections from exceeding the member's
-- current balance on the same point card. Final redemption still revalidates
-- the balance because points may change after the booking is created.

create or replace function public.validate_booking_point_ticket_balance()
returns trigger
language plpgsql
security invoker
set search_path to 'public','pg_temp'
as $function$
declare
  v_point_card_id uuid;
  v_threshold integer := 0;
  v_balance integer := 0;
  v_existing_required integer := 0;
begin
  if new.benefit_kind <> 'points' or new.status <> 'pending' then
    return new;
  end if;

  select pt.point_card_id, pt.threshold_stamps
    into v_point_card_id, v_threshold
  from public.point_tickets pt
  where pt.member_id = new.member_id
    and pt.ticket_id = new.benefit_ref
    and pt.status = 'available';

  -- Availability/ownership is enforced by replace_booking_benefit_selections_request.
  -- This trigger owns only the balance invariant.
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
  where b.booking_id = new.booking_id
    and b.member_id = new.member_id
    and b.benefit_kind = 'points'
    and b.status = 'pending'
    and pt.point_card_id = v_point_card_id;

  if v_existing_required + coalesce(v_threshold, 0) > v_balance then
    raise exception 'POINT_TICKET_INSUFFICIENT_POINTS';
  end if;

  return new;
end;
$function$;

revoke all on function public.validate_booking_point_ticket_balance() from public, anon, authenticated;

drop trigger if exists booking_point_ticket_balance_guard on public.booking_benefit_selections;
create trigger booking_point_ticket_balance_guard
before insert on public.booking_benefit_selections
for each row
execute function public.validate_booking_point_ticket_balance();
