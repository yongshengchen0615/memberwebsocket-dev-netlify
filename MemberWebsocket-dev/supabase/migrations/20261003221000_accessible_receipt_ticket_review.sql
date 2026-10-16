begin;

-- Accessible receipt review binds the admin-approved tickets before canonical
-- completion so ticket redemption, reward points and service time settle together.
CREATE OR REPLACE FUNCTION public.register_accessible_receipt_with_benefits_request(p_receipt_id text, p_expected_receipt_updated_at timestamp with time zone, p_actor text, p_booking_id uuid, p_booking_date date, p_start_time time without time zone, p_items jsonb, p_benefits jsonb, p_admin_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r public.booking_receipts%rowtype;
  b public.bookings%rowtype;
  m public.members%rowtype;
  s public.booking_services%rowtype;
  settings public.booking_settings%rowtype;
  item jsonb;
  minutes integer;
  quantity integer;
  total integer := 0;
  participant uuid;
  store_id constant uuid := '00000000-0000-4000-8000-000000000010';
  store public.booking_services%rowtype;
  start_at timestamp;
  settlement jsonb;
begin
  perform 1 from public.admins where line_user_id = p_actor and role = 'admin' and status = 'active';
  if not found then raise exception 'ADMIN_REQUIRED'; end if;

  p_benefits := coalesce(p_benefits, '[]'::jsonb);
  if jsonb_typeof(p_benefits) <> 'array' or jsonb_array_length(p_benefits) > 20 then
    raise exception 'INVALID_BOOKING_BENEFITS';
  end if;

  select * into r from public.booking_receipts where receipt_id = p_receipt_id;
  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;

  select * into m from public.members where id = r.member_id for update;
  if m.status <> 'active' or m.membership_status <> 'active' then raise exception 'MEMBERSHIP_REQUIRED'; end if;

  select * into r from public.booking_receipts where receipt_id = p_receipt_id for update;
  if r.submission_mode <> 'accessible' then raise exception 'RECEIPT_NOT_PENDING'; end if;

  if r.status = 'bound' then
    select jsonb_build_object(
      'bookingId', booking_id,
      'serviceMinutes', service_minutes,
      'rewards', reward_details
    )
      into settlement
    from public.booking_completion_settlements
    where booking_id = r.booking_id;

    return jsonb_build_object(
      'bookingId', r.booking_id,
      'receiptId', r.receipt_id,
      'settlement', settlement,
      'alreadyApplied', true
    );
  end if;

  if r.status <> 'awaiting_review' or r.booking_id is not null then raise exception 'RECEIPT_NOT_PENDING'; end if;
  if p_expected_receipt_updated_at is null or r.updated_at <> p_expected_receipt_updated_at then raise exception 'BOOKING_CONFLICT'; end if;

  if p_booking_id is not null then
    select * into b from public.bookings where id = p_booking_id for update;
    if not found or b.member_id <> r.member_id then raise exception 'BOOKING_NOT_OWNED'; end if;
    if b.status not in ('confirmed', 'completed') then raise exception 'INVALID_BOOKING_TRANSITION'; end if;
    if b.end_at > (clock_timestamp() at time zone 'Asia/Taipei') then raise exception 'BOOKING_NOT_FINISHED_YET'; end if;
    if exists(
      select 1
      from public.booking_receipts
      where booking_id = b.id
        and status in ('pending_upload', 'awaiting_review', 'bound')
    ) then
      raise exception 'BOOKING_ALREADY_COMPLETED_WITH_RECEIPT';
    end if;
  else
    if p_booking_date is null or p_start_time is null or extract(second from p_start_time) <> 0 then
      raise exception 'INVALID_BOOKING_SLOT';
    end if;
    if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then
      raise exception 'INVALID_BOOKING_ITEMS';
    end if;
    if (select count(distinct x->>'serviceId') from jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) then
      raise exception 'INVALID_BOOKING_ITEMS';
    end if;

    select * into settings from public.booking_settings where id = 1;
    if settings.primary_technician_id is null then raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING'; end if;
    perform 1 from public.booking_technicians where id = settings.primary_technician_id and is_active;
    if not found then raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING'; end if;

    select * into store
    from public.booking_services
    where id = store_id and is_active and deleted_at is null;
    if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;

    for item in select value from jsonb_array_elements(p_items) loop
      select * into s
      from public.booking_services
      where id = (item->>'serviceId')::uuid
        and is_active
        and deleted_at is null
        and id <> store_id
      for share;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;

      minutes := (item->>'minutes')::integer;
      quantity := (item->>'quantity')::integer;
      if minutes is null or minutes not between 1 and 720 or quantity is null or quantity not between 1 and 20 then
        raise exception 'INVALID_BOOKING_ITEMS';
      end if;
      total := total + minutes * quantity;
    end loop;

    total := total + store.duration_minutes;
    if total not between 1 and 1439 then raise exception 'INVALID_BOOKING_DURATION'; end if;

    start_at := p_booking_date + p_start_time
      + case
          when settings.work_end_time < settings.work_start_time and p_start_time < settings.work_end_time
            then interval '1 day'
          else interval '0 days'
        end;
    if start_at + make_interval(mins => total) > (clock_timestamp() at time zone 'Asia/Taipei') then
      raise exception 'BOOKING_NOT_FINISHED_YET';
    end if;

    insert into public.bookings(
      request_id, service_id, member_id, booking_date, start_time, end_time, status,
      total_duration_minutes, technician_id, party_size, confirmed_by, confirmed_at, receipt_submission_id,
      contact_source, contact_surname, contact_salutation, contact_phone
    )
    values(
      'receipt-register:' || r.id::text,
      (p_items->0->>'serviceId')::uuid,
      r.member_id,
      p_booking_date,
      p_start_time,
      (p_start_time + make_interval(mins => total))::time,
      'confirmed',
      total,
      settings.primary_technician_id,
      1,
      p_actor,
      now(),
      r.receipt_id,
      'member',
      m.surname,
      m.salutation,
      m.phone
    )
    returning * into b;

    insert into public.booking_participants(booking_id, position, technician_id)
    values(b.id, 1, settings.primary_technician_id)
    returning id into participant;

    for item in select value from jsonb_array_elements(p_items) loop
      select * into s from public.booking_services where id = (item->>'serviceId')::uuid;

      insert into public.booking_items(
        booking_id, service_id, service_title, unit_duration_minutes, quantity,
        unit_price_amount, service_type, counts_toward_membership
      )
      values(
        b.id, s.id, s.title, (item->>'minutes')::integer, (item->>'quantity')::integer,
        s.price_amount, s.service_type, s.counts_toward_membership
      );

      insert into public.booking_participant_items(
        participant_id, service_id, service_title, unit_duration_minutes, unit_price_amount, quantity
      )
      values(
        participant, s.id, s.title, (item->>'minutes')::integer, s.price_amount, (item->>'quantity')::integer
      );
    end loop;

    insert into public.booking_items(
      booking_id, service_id, service_title, unit_duration_minutes, quantity,
      unit_price_amount, service_type, counts_toward_membership
    )
    values(b.id, store.id, store.title, store.duration_minutes, 1, store.price_amount, store.service_type, false);

    insert into public.booking_participant_items(
      participant_id, service_id, service_title, unit_duration_minutes, unit_price_amount, quantity
    )
    values(participant, store.id, store.title, store.duration_minutes, store.price_amount, 1);
  end if;

  if b.status = 'confirmed' then
    perform public.replace_booking_benefit_selections_request(
      b.id,
      r.member_id,
      p_benefits
    );
  elsif jsonb_array_length(p_benefits) > 0 then
    raise exception 'BOOKING_NOT_EDITABLE';
  end if;

  update public.booking_receipts set booking_id = b.id where id = r.id;

  if b.status = 'completed' then
    select jsonb_build_object(
      'bookingId', booking_id,
      'serviceMinutes', service_minutes,
      'rewards', reward_details
    )
      into settlement
    from public.booking_completion_settlements
    where booking_id = b.id;
    if settlement is null then raise exception 'BOOKING_COMPLETION_REQUIRES_SETTLEMENT'; end if;
    update public.booking_receipts
    set status = 'bound', bound_at = now(), updated_at = now()
    where id = r.id;
  else
    settlement := public.admin_confirm_booking_receipt_request(
      b.id,
      b.updated_at,
      p_actor,
      left(coalesce(p_admin_note, ''), 500)
    )->'settlement';
  end if;

  insert into public.audit_logs(
    audit_id, actor_line_user_id, actor_role, action, target_type, target_id, result, detail
  )
  values(
    public.new_public_id('AUD'),
    p_actor,
    'admin',
    'admin.booking.receipt.register',
    'booking',
    b.id::text,
    'success',
    jsonb_build_object(
      'receiptId', r.receipt_id,
      'linkedExisting', p_booking_id is not null,
      'benefitCount', jsonb_array_length(p_benefits)
    )
  );

  return jsonb_build_object(
    'bookingId', b.id,
    'receiptId', r.receipt_id,
    'settlement', settlement,
    'alreadyApplied', false
  );
end
$function$
;

commit;
