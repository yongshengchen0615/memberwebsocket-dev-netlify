-- PostgreSQL fires BEFORE INSERT triggers for INSERT ... ON CONFLICT DO UPDATE
-- before checking the unique conflict. The INSERT candidate holds only the
-- service reward increment, not the member's resulting point balance.
-- Never reject a funded existing balance based on that temporary value.
-- The UPDATE trigger still checks the actual post-conflict balance.
begin;

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

  if coalesce(new.stamps, 0) < v_reserved_points then
    if tg_op = 'INSERT' then
      -- On a conflicting key, INSERT never persists: DO UPDATE runs its
      -- own BEFORE UPDATE guard against the actual resulting balance.
      -- A true first insert below the reserved budget remains forbidden.
      if not exists (
        select 1
        from public.point_balances existing
        where existing.member_id = new.member_id
          and existing.point_card_id = new.point_card_id
      ) then
        raise exception 'INSUFFICIENT_POINTS';
      end if;
    elsif coalesce(new.stamps, 0) < coalesce(old.stamps, 0) then
      -- Preserve existing behavior: forbid reductions below reservations
      -- while allowing increases that heal legacy underfunded balances.
      raise exception 'INSUFFICIENT_POINTS';
    end if;
  end if;

  return new;
end;
$function$;

commit;
