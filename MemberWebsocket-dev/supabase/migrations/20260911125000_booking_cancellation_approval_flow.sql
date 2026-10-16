begin;

alter table public.bookings
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancellation_requested_by text,
  add column if not exists cancellation_source_status text,
  add column if not exists cancellation_reviewed_at timestamptz,
  add column if not exists cancellation_reviewed_by text,
  add column if not exists cancellation_decision text;

alter table public.bookings drop constraint if exists bookings_cancellation_source_status_check;
alter table public.bookings add constraint bookings_cancellation_source_status_check
  check (cancellation_source_status is null or cancellation_source_status in ('pending','confirmed'));

alter table public.bookings drop constraint if exists bookings_cancellation_decision_check;
alter table public.bookings add constraint bookings_cancellation_decision_check
  check (cancellation_decision is null or cancellation_decision in ('approved','rejected'));

alter table public.bookings drop constraint if exists bookings_cancellation_request_consistency_check;
alter table public.bookings add constraint bookings_cancellation_request_consistency_check
  check (
    (cancellation_requested_at is null and cancellation_requested_by is null and cancellation_source_status is null)
    or
    (cancellation_requested_at is not null and cancellation_requested_by is not null and cancellation_source_status is not null)
  );

create index if not exists bookings_pending_cancellation_idx
  on public.bookings (cancellation_requested_at, booking_date, start_time)
  where cancellation_requested_at is not null and cancellation_reviewed_at is null;

comment on column public.bookings.cancellation_requested_at is
  'When a member requested cancellation. Booking status remains pending/confirmed until admin review.';
comment on column public.bookings.cancellation_requested_by is
  'LINE user id that requested cancellation.';
comment on column public.bookings.cancellation_source_status is
  'Booking status at cancellation request time; used to preserve the reservation until review.';
comment on column public.bookings.cancellation_decision is
  'Admin review decision: approved or rejected.';

commit;
