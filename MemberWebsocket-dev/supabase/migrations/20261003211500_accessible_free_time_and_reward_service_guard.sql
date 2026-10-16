begin;

-- Accessible receipt registration records completed real-world service and is not
-- constrained by the member booking slot grid. Minute precision is sufficient.
create or replace function public.register_accessible_receipt_request(
  p_receipt_id text,p_expected_receipt_updated_at timestamptz,p_actor text,
  p_booking_id uuid,p_booking_date date,p_start_time time,p_items jsonb,p_admin_note text
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  r public.booking_receipts%rowtype; b public.bookings%rowtype; m public.members%rowtype;
  s public.booking_services%rowtype; settings public.booking_settings%rowtype;
  item jsonb; minutes integer; quantity integer; total integer:=0; participant uuid;
  store_id constant uuid:='00000000-0000-4000-8000-000000000010';
  store public.booking_services%rowtype; start_at timestamp; settlement jsonb;
begin
  perform 1 from public.admins where line_user_id=p_actor and role='admin' and status='active';
  if not found then raise exception 'ADMIN_REQUIRED'; end if;
  select * into r from public.booking_receipts where receipt_id=p_receipt_id;
  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;
  select * into m from public.members where id=r.member_id for update;
  if m.status<>'active' or m.membership_status<>'active' then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  select * into r from public.booking_receipts where receipt_id=p_receipt_id for update;
  if r.submission_mode<>'accessible' then raise exception 'RECEIPT_NOT_PENDING'; end if;
  if r.status='bound' then
    select jsonb_build_object('bookingId',booking_id,'serviceMinutes',service_minutes,'rewards',reward_details)
      into settlement from public.booking_completion_settlements where booking_id=r.booking_id;
    return jsonb_build_object('bookingId',r.booking_id,'receiptId',r.receipt_id,'settlement',settlement,'alreadyApplied',true);
  end if;
  if r.status<>'awaiting_review' or r.booking_id is not null then raise exception 'RECEIPT_NOT_PENDING'; end if;
  if p_expected_receipt_updated_at is null or r.updated_at<>p_expected_receipt_updated_at then raise exception 'BOOKING_CONFLICT'; end if;
  if p_booking_id is not null then
    select * into b from public.bookings where id=p_booking_id for update;
    if not found or b.member_id<>r.member_id then raise exception 'BOOKING_NOT_OWNED'; end if;
    if b.status not in ('confirmed','completed') then raise exception 'INVALID_BOOKING_TRANSITION'; end if;
    if b.end_at>(clock_timestamp() at time zone 'Asia/Taipei') then raise exception 'BOOKING_NOT_FINISHED_YET'; end if;
    if exists(select 1 from public.booking_receipts where booking_id=b.id and status in ('pending_upload','awaiting_review','bound')) then
      raise exception 'BOOKING_ALREADY_COMPLETED_WITH_RECEIPT'; end if;
  else
    if p_booking_date is null or p_start_time is null or extract(second from p_start_time)<>0
      then raise exception 'INVALID_BOOKING_SLOT'; end if;
    if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then raise exception 'INVALID_BOOKING_ITEMS'; end if;
    if (select count(distinct x->>'serviceId') from jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) then raise exception 'INVALID_BOOKING_ITEMS'; end if;
    select * into settings from public.booking_settings where id=1;
    if settings.primary_technician_id is null then raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING'; end if;
    perform 1 from public.booking_technicians where id=settings.primary_technician_id and is_active;
    if not found then raise exception 'BOOKING_PRIMARY_TECHNICIAN_MISSING'; end if;
    select * into store from public.booking_services where id=store_id and is_active and deleted_at is null;
    if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
    for item in select value from jsonb_array_elements(p_items) loop
      select * into s from public.booking_services where id=(item->>'serviceId')::uuid and is_active and deleted_at is null and id<>store_id for share;
      if not found then raise exception 'BOOKING_SERVICE_NOT_FOUND'; end if;
      minutes:=(item->>'minutes')::integer; quantity:=(item->>'quantity')::integer;
      if minutes is null or minutes not between 1 and 720 or quantity is null or quantity not between 1 and 20 then raise exception 'INVALID_BOOKING_ITEMS'; end if;
      total:=total+minutes*quantity;
    end loop;
    total:=total+store.duration_minutes;
    if total not between 1 and 1439 then raise exception 'INVALID_BOOKING_DURATION'; end if;
    start_at:=p_booking_date+p_start_time+case when settings.work_end_time<settings.work_start_time and p_start_time<settings.work_end_time then interval '1 day' else interval '0 days' end;
    if start_at+make_interval(mins=>total)>(clock_timestamp() at time zone 'Asia/Taipei') then raise exception 'BOOKING_NOT_FINISHED_YET'; end if;
    -- Do not invent a future reservation for a service that already happened.
    insert into public.bookings(request_id,service_id,member_id,booking_date,start_time,end_time,status,
      total_duration_minutes,technician_id,party_size,confirmed_by,confirmed_at,receipt_submission_id,
      contact_source,contact_surname,contact_salutation,contact_phone)
    values('receipt-register:'||r.id::text,(p_items->0->>'serviceId')::uuid,r.member_id,p_booking_date,p_start_time,
      (p_start_time+make_interval(mins=>total))::time,'confirmed',total,settings.primary_technician_id,1,p_actor,now(),r.receipt_id,
      'member',m.surname,m.salutation,m.phone) returning * into b;
    insert into public.booking_participants(booking_id,position,technician_id)
      values(b.id,1,settings.primary_technician_id) returning id into participant;
    for item in select value from jsonb_array_elements(p_items) loop
      select * into s from public.booking_services where id=(item->>'serviceId')::uuid;
      insert into public.booking_items(booking_id,service_id,service_title,unit_duration_minutes,quantity,unit_price_amount,service_type,counts_toward_membership)
      values(b.id,s.id,s.title,(item->>'minutes')::integer,(item->>'quantity')::integer,s.price_amount,s.service_type,s.counts_toward_membership);
      insert into public.booking_participant_items(participant_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity)
      values(participant,s.id,s.title,(item->>'minutes')::integer,s.price_amount,(item->>'quantity')::integer);
    end loop;
    insert into public.booking_items(booking_id,service_id,service_title,unit_duration_minutes,quantity,unit_price_amount,service_type,counts_toward_membership)
    values(b.id,store.id,store.title,store.duration_minutes,1,store.price_amount,store.service_type,false);
    insert into public.booking_participant_items(participant_id,service_id,service_title,unit_duration_minutes,unit_price_amount,quantity)
    values(participant,store.id,store.title,store.duration_minutes,store.price_amount,1);
  end if;
  update public.booking_receipts set booking_id=b.id where id=r.id;
  if b.status='completed' then
    select jsonb_build_object('bookingId',booking_id,'serviceMinutes',service_minutes,'rewards',reward_details)
      into settlement from public.booking_completion_settlements where booking_id=b.id;
    if settlement is null then raise exception 'BOOKING_COMPLETION_REQUIRES_SETTLEMENT'; end if;
    update public.booking_receipts set status='bound',bound_at=now(),updated_at=now() where id=r.id;
  else
    settlement:=public.admin_confirm_booking_receipt_request(b.id,b.updated_at,p_actor,left(coalesce(p_admin_note,''),500))->'settlement';
  end if;
  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
  values(public.new_public_id('AUD'),p_actor,'admin','admin.booking.receipt.register','booking',b.id::text,'success',
    jsonb_build_object('receiptId',r.receipt_id,'linkedExisting',p_booking_id is not null));
  return jsonb_build_object('bookingId',b.id,'receiptId',r.receipt_id,'settlement',settlement,'alreadyApplied',false);
end $$;

-- The internal store-service row is bookkeeping infrastructure, not a selectable
-- booking requirement for reward-node tickets.
create or replace function public.save_point_card_service_items(
  p_actor_line_user_id text,
  p_card jsonb,
  p_expected_updated_at timestamp with time zone
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card_id text;
  v_card_uuid uuid;
  v_reward jsonb;
  v_threshold integer;
  v_reward_id uuid;
  v_required_service_ids uuid[] := '{}'::uuid[];
  v_required_service_match_mode text := 'any';
  v_requested_count integer := 0;
begin
  v_card_id := public.save_point_card(p_actor_line_user_id, p_card, p_expected_updated_at);

  select id into v_card_uuid
  from public.point_cards
  where card_id = v_card_id;

  if v_card_uuid is null then
    raise exception 'POINT_CARD_NOT_FOUND';
  end if;

  if jsonb_typeof(p_card->'rewards') = 'array' then
    for v_reward in select value from jsonb_array_elements(p_card->'rewards')
    loop
      begin
        v_threshold := (v_reward->>'thresholdStamps')::integer;
      exception when others then
        raise exception 'INVALID_REWARD_THRESHOLD';
      end;

      v_required_service_ids := '{}'::uuid[];
      v_required_service_match_mode := case
        when lower(btrim(coalesce(v_reward->>'requiredServiceMatchMode', 'any'))) = 'all' then 'all'
        else 'any'
      end;
      v_requested_count := 0;

      if v_reward ? 'requiredServiceIds' and v_reward->'requiredServiceIds' is not null then
        if jsonb_typeof(v_reward->'requiredServiceIds') <> 'array'
           or jsonb_array_length(v_reward->'requiredServiceIds') > 20 then
          raise exception 'INVALID_REQUIRED_SERVICE_IDS';
        end if;

        select count(distinct btrim(value))
          into v_requested_count
        from jsonb_array_elements_text(v_reward->'requiredServiceIds')
        where btrim(value) <> '';

        select coalesce(array_agg(bs.id order by bs.created_at, bs.id), '{}'::uuid[])
          into v_required_service_ids
        from public.booking_services bs
        where bs.deleted_at is null
          and bs.id <> '00000000-0000-4000-8000-000000000010'::uuid
          and exists (
            select 1
            from jsonb_array_elements_text(v_reward->'requiredServiceIds') requested(value)
            where btrim(requested.value) = bs.id::text
          );

        if cardinality(v_required_service_ids) <> v_requested_count then
          raise exception 'INVALID_REQUIRED_SERVICE_IDS';
        end if;
      end if;

      select id into v_reward_id
      from public.point_card_rewards
      where point_card_id = v_card_uuid and threshold_stamps = v_threshold
      limit 1;

      if v_reward_id is null then
        raise exception 'INVALID_REWARD_THRESHOLD';
      end if;

      update public.point_card_rewards
      set required_service_ids = v_required_service_ids,
          required_service_match_mode = v_required_service_match_mode,
          updated_at = now()
      where id = v_reward_id;
    end loop;
  end if;

  return v_card_id;
end;
$$;

commit;
