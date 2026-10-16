begin;

-- Regular member/admin bookings remain aligned to the five-minute start boundary.
-- Accessible receipt registration is a historical service record and may use any
-- minute value, identified by its internal receipt-register request id plus the
-- bound receipt submission id.
alter table public.bookings
  drop constraint if exists bookings_start_boundary_check;

alter table public.bookings
  add constraint bookings_start_boundary_check
  check (
    (
      receipt_submission_id is not null
      and request_id like 'receipt-register:%'
      and extract(second from start_time) = 0
    )
    or (
      extract(second from start_time) = 0
      and extract(minute from start_time)::integer % 5 = 0
    )
  );

commit;
