-- Follow-up for environments where the initial lifecycle repair was already deployed.
-- Reassert the strict cancellation lock and stale-notification rules.

create or replace function public.guard_pending_booking_cancellation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.cancellation_requested_at is not null
     and old.cancellation_reviewed_at is null
  then
    -- While review is pending, the booking is immutable. Only the explicit
    -- approval/rejection transitions may change it.
    if new.status = 'cancelled'
       and new.cancellation_reviewed_at is not null
       and new.cancellation_decision = 'approved'
    then
      return new;
    end if;

    if new.status is not distinct from old.status
       and new.cancellation_requested_at is null
       and new.cancellation_reviewed_at is not null
       and new.cancellation_decision = 'rejected'
    then
      return new;
    end if;

    raise exception 'BOOKING_CANCELLATION_PENDING';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_pending_cancellation_guard on public.bookings;
create trigger bookings_pending_cancellation_guard
before update on public.bookings
for each row execute function public.guard_pending_booking_cancellation();

revoke all on function public.guard_pending_booking_cancellation() from public, anon, authenticated;

-- Do not deliver lifecycle messages that have already been superseded by the
-- current terminal state. Keep the matching terminal notification.
update booking_notifications.outbox q
set status = 'skipped',
    last_error = 'Superseded by current booking lifecycle state'
from public.bookings b
where q.booking_id = b.id
  and q.status in ('pending','sending')
  and (
    (b.status = 'cancelled' and q.event_key not like (b.id::text || ':cancelled:%'))
    or (b.status = 'completed' and q.event_key not like (b.id::text || ':completed:%'))
    or (b.status = 'rejected' and q.event_key not like (b.id::text || ':rejected:%'))
    or (
      b.status in ('pending','confirmed')
      and b.cancellation_requested_at is not null
      and b.cancellation_reviewed_at is null
      and q.event_key not like (b.id::text || ':cancellation_requested:%')
    )
    or (
      b.status in ('pending','confirmed')
      and b.cancellation_decision = 'rejected'
      and b.cancellation_reviewed_at is not null
      and q.event_key like (b.id::text || ':cancellation_requested:%')
    )
  );

create or replace function public.claim_booking_notifications(p_limit integer default 20)
returns setof booking_notifications.outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce((select enabled from booking_notifications.config where id), false) then
    return;
  end if;

  update booking_notifications.outbox
  set status = 'failed',
      last_error = 'Retry limit reached'
  where status in ('pending','sending')
    and next_attempt_at <= now()
    and (attempt_count >= 5 or first_attempt_at < now() - interval '12 hours');

  update booking_notifications.outbox q
  set status = 'skipped',
      last_error = 'Administrator no longer active'
  where q.status in ('pending','sending')
    and q.channel = 'admin'
    and q.next_attempt_at <= now()
    and not exists (
      select 1
      from public.admins a
      where a.line_user_id = q.recipient
        and a.status = 'active'
        and a.role = 'admin'
    );

  update booking_notifications.outbox q
  set status = 'skipped',
      last_error = 'Superseded by current booking lifecycle state'
  from public.bookings b
  where q.booking_id = b.id
    and q.status in ('pending','sending')
    and q.next_attempt_at <= now()
    and (
      (b.status = 'cancelled' and q.event_key not like (b.id::text || ':cancelled:%'))
      or (b.status = 'completed' and q.event_key not like (b.id::text || ':completed:%'))
      or (b.status = 'rejected' and q.event_key not like (b.id::text || ':rejected:%'))
      or (
        b.status in ('pending','confirmed')
        and b.cancellation_requested_at is not null
        and b.cancellation_reviewed_at is null
        and q.event_key not like (b.id::text || ':cancellation_requested:%')
      )
      or (
        b.status in ('pending','confirmed')
        and b.cancellation_decision = 'rejected'
        and b.cancellation_reviewed_at is not null
        and q.event_key like (b.id::text || ':cancellation_requested:%')
      )
    );

  return query
  with due as (
    select id
    from booking_notifications.outbox
    where status in ('pending','sending')
      and next_attempt_at <= now()
    order by next_attempt_at, created_at
    limit greatest(1, least(p_limit, 20))
    for update skip locked
  )
  update booking_notifications.outbox q
  set status = 'sending',
      attempt_count = q.attempt_count + 1,
      first_attempt_at = coalesce(q.first_attempt_at, now()),
      next_attempt_at = now() + interval '2 minutes'
  from due
  where q.id = due.id
  returning q.*;
end;
$$;
