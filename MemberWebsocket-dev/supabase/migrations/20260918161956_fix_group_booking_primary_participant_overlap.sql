-- Group bookings use per-participant technician reservations for exact capacity.
-- bookings.technician_id remains the primary technician compatibility field, but it
-- must not reserve that technician for the whole group duration.

do $$
begin
  if exists (
    select 1
    from public.bookings b
    join public.booking_participants bp on bp.booking_id = b.id
    where b.party_size > 1
      and b.status in ('pending','confirmed')
      and bp.technician_id is not null
      and not exists (
        select 1
        from public.booking_participant_reservations r
        where r.participant_id = bp.id
          and r.booking_id = b.id
          and r.technician_id = bp.technician_id
          and r.is_active
      )
  ) then
    raise exception 'GROUP_BOOKING_RESERVATION_COVERAGE_INCOMPLETE';
  end if;
end
$$;

alter table public.bookings
  drop constraint if exists bookings_no_active_technician_overlap;

alter table public.bookings
  add constraint bookings_no_active_technician_overlap
  exclude using gist (
    technician_id with =,
    booking_date with =,
    tsrange(booking_date + start_time, booking_date + end_time, '[)') with &&
  )
  where (
    status in ('pending','confirmed')
    and party_size = 1
  );
