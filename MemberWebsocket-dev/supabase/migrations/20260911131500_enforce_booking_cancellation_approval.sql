begin;

create or replace function public.enforce_booking_cancellation_approval()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.status is distinct from 'cancelled' and new.status = 'cancelled' then
    if new.cancellation_decision = 'approved'
       and new.cancellation_requested_at is not null
       and new.cancellation_reviewed_at is not null
       and new.cancellation_reviewed_by is not null then
      return new;
    end if;

    if new.cancelled_by is not null and exists (
      select 1
      from public.admins a
      where a.line_user_id = new.cancelled_by
        and a.role = 'admin'
        and a.status = 'active'
    ) then
      return new;
    end if;

    raise exception 'BOOKING_CANCELLATION_APPROVAL_REQUIRED';
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_enforce_cancellation_approval on public.bookings;
create trigger bookings_enforce_cancellation_approval
before update of status on public.bookings
for each row
execute function public.enforce_booking_cancellation_approval();

comment on function public.enforce_booking_cancellation_approval() is
  'Prevents member-side direct cancellation. A booking may become cancelled only after admin approval of a member cancellation request or by an active admin directly.';

commit;
