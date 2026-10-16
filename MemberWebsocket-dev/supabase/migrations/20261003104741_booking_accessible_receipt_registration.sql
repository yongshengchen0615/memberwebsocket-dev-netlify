begin;

-- A member may submit a private receipt before any reservation exists.
alter table public.booking_receipts alter column booking_id drop not null;
alter table public.booking_receipts add column submission_mode text not null default 'booking'
  check (submission_mode in ('booking','accessible'));
alter table public.booking_receipts add constraint booking_receipts_booking_required
  check (booking_id is not null or submission_mode='accessible');
create unique index booking_receipts_accessible_pending_member on public.booking_receipts(member_id)
  where submission_mode='accessible' and booking_id is null and status='pending_upload';
create unique index booking_receipts_accessible_review_member on public.booking_receipts(member_id)
  where submission_mode='accessible' and booking_id is null and status='awaiting_review';
-- Only a verified member receipt allows a retrospective service registration.
-- Keep the existing booking_receipts -> bookings Data API relationship unambiguous.
-- This marker is checked by the server-only registration RPC and schedule guards.
-- The actual receipt FK remains booking_receipts.booking_id.
alter table public.bookings add column receipt_submission_id text unique;

create or replace function public.prepare_accessible_receipt_request(
  p_member_id uuid,p_request_id text,p_object_path text,p_mime_type text,p_size_bytes integer
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v public.booking_receipts%rowtype;
begin
  perform 1 from public.members where id=p_member_id and status='active' and membership_status='active' for update;
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  if coalesce(p_request_id,'') !~ '^[A-Za-z0-9_-]{8,120}$' then raise exception 'INVALID_REQUEST_ID'; end if;
  if p_mime_type is null or p_mime_type not in ('image/jpeg','image/png','image/webp','image/heic','image/heif') then raise exception 'RECEIPT_INVALID_MIME'; end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 5242880 then raise exception 'RECEIPT_FILE_TOO_LARGE'; end if;
  if p_object_path is null or p_object_path not like p_member_id::text||'/accessible/%' then raise exception 'RECEIPT_INVALID_PATH'; end if;
  select * into v from public.booking_receipts where member_id=p_member_id and request_id=p_request_id for update;
  if found then
    if v.submission_mode<>'accessible' or v.declared_mime_type<>p_mime_type or v.declared_size_bytes<>p_size_bytes then raise exception 'REQUEST_ID_CONFLICT'; end if;
    if v.status not in ('pending_upload','awaiting_review','bound') then raise exception 'RECEIPT_NOT_PENDING'; end if;
    return jsonb_build_object('receiptId',v.receipt_id,'objectPath',v.object_path,'status',v.status,'alreadyPrepared',true);
  end if;
  with replaced as (
    update public.booking_receipts set status='failed',failure_reason='upload-replaced',updated_at=now()
    where member_id=p_member_id and submission_mode='accessible' and booking_id is null and status='pending_upload'
    returning object_path
  ) insert into public.booking_receipt_cleanup_queue(object_path,reason)
    select object_path,'upload-replaced' from replaced on conflict(object_path) do nothing;
  insert into public.booking_receipts(receipt_id,member_id,request_id,object_path,declared_mime_type,declared_size_bytes,submission_mode)
  values(public.new_public_id('BR'),p_member_id,p_request_id,p_object_path,p_mime_type,p_size_bytes,'accessible') returning * into v;
  return jsonb_build_object('receiptId',v.receipt_id,'objectPath',v.object_path,'status',v.status);
end $$;

create or replace function public.finalize_accessible_receipt_request(
  p_receipt_id text,p_member_id uuid,p_actor_line_user_id text,p_actual_mime_type text,p_actual_size_bytes integer,p_sha256_hex text
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v public.booking_receipts%rowtype;
begin
  -- Same member lock order as prepare/register serializes replacement and settlement.
  perform 1 from public.members where id=p_member_id and line_user_id=p_actor_line_user_id
    and status='active' and membership_status='active' for update;
  if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
  select * into v from public.booking_receipts where receipt_id=p_receipt_id for update;
  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;
  if v.member_id<>p_member_id or v.submission_mode<>'accessible' then raise exception 'RECEIPT_NOT_OWNED'; end if;
  if v.status in ('awaiting_review','bound') then
    return jsonb_build_object('receiptId',v.receipt_id,'bookingId',v.booking_id,'status',v.status,'alreadyApplied',true);
  end if;
  if v.status<>'pending_upload' or v.booking_id is not null then raise exception 'RECEIPT_NOT_PENDING'; end if;
  if lower(coalesce(p_actual_mime_type,''))<>v.declared_mime_type then raise exception 'RECEIPT_MIME_MISMATCH'; end if;
  if p_actual_size_bytes is null or p_actual_size_bytes<>v.declared_size_bytes then raise exception 'RECEIPT_SIZE_MISMATCH'; end if;
  if lower(coalesce(p_sha256_hex,'')) !~ '^[a-f0-9]{64}$' then raise exception 'RECEIPT_INVALID_HASH'; end if;
  with replaced as (
    update public.booking_receipts set status='failed',failure_reason='snapshot-replaced',updated_at=now()
    where member_id=p_member_id and submission_mode='accessible' and booking_id is null and status='awaiting_review'
    returning object_path
  ) insert into public.booking_receipt_cleanup_queue(object_path,reason)
    select object_path,'snapshot-replaced' from replaced on conflict(object_path) do nothing;
  update public.booking_receipts set status='awaiting_review',actual_mime_type=p_actual_mime_type,
    actual_size_bytes=p_actual_size_bytes,sha256_hex=lower(p_sha256_hex),updated_at=now() where id=v.id;
  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
  values(public.new_public_id('AUD'),p_actor_line_user_id,'member','user.booking.receipt.accessible.submit',
    'receipt',p_receipt_id,'success',jsonb_build_object('nextState','awaiting_review'));
  return jsonb_build_object('receiptId',p_receipt_id,'status','awaiting_review','alreadyApplied',false);
end $$;

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
      or extract(minute from p_start_time)::integer%5<>0 then raise exception 'INVALID_BOOKING_SLOT'; end if;
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

create or replace function public.dismiss_accessible_receipt_request(p_receipt_id text,p_expected_updated_at timestamptz,p_actor text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare r public.booking_receipts%rowtype;
begin
  perform 1 from public.admins where line_user_id=p_actor and role='admin' and status='active';
  if not found then raise exception 'ADMIN_REQUIRED'; end if;
  select * into r from public.booking_receipts where receipt_id=p_receipt_id;
  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;
  perform 1 from public.members where id=r.member_id for update;
  select * into r from public.booking_receipts where receipt_id=p_receipt_id for update;
  if r.status='failed' and r.failure_reason='admin-dismissed' then return true; end if;
  if r.submission_mode<>'accessible' or r.booking_id is not null or r.status<>'awaiting_review' then raise exception 'RECEIPT_NOT_PENDING'; end if;
  if p_expected_updated_at is null or r.updated_at<>p_expected_updated_at then raise exception 'BOOKING_CONFLICT'; end if;
  update public.booking_receipts set status='failed',failure_reason='admin-dismissed',updated_at=now() where id=r.id;
  insert into public.booking_receipt_cleanup_queue(object_path,reason) values(r.object_path,'admin-dismissed') on conflict(object_path) do nothing;
  insert into public.audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail)
  values(public.new_public_id('AUD'),p_actor,'admin','admin.booking.receipt.dismiss','receipt',p_receipt_id,'success','{}');
  return true;
end $$;

revoke all on function public.prepare_accessible_receipt_request(uuid,text,text,text,integer) from public,anon,authenticated;
revoke all on function public.finalize_accessible_receipt_request(text,uuid,text,text,integer,text) from public,anon,authenticated;
revoke all on function public.register_accessible_receipt_request(text,timestamptz,text,uuid,date,time,jsonb,text) from public,anon,authenticated;
revoke all on function public.dismiss_accessible_receipt_request(text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.prepare_accessible_receipt_request(uuid,text,text,text,integer) to service_role;
grant execute on function public.finalize_accessible_receipt_request(text,uuid,text,text,integer,text) to service_role;
grant execute on function public.register_accessible_receipt_request(text,timestamptz,text,uuid,date,time,jsonb,text) to service_role;
grant execute on function public.dismiss_accessible_receipt_request(text,timestamptz,text) to service_role;

-- Guard modifications are appended below from their current repository/database definitions.

CREATE OR REPLACE FUNCTION public.enforce_booking_advance_window()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_settings public.booking_settings%rowtype;
  v_today date;
begin
  if new.receipt_submission_id is not null and exists (
    select 1 from public.booking_receipts r
    where r.receipt_id=new.receipt_submission_id and r.member_id=new.member_id
      and r.submission_mode='accessible' and r.status in ('awaiting_review','bound')
  ) then return new; end if;
  if tg_op = 'UPDATE' and new.booking_date is not distinct from old.booking_date then return new; end if;
  select * into v_settings from public.booking_settings where id = 1;
  if not found then raise exception 'BOOKING_SETTINGS_MISSING'; end if;
  v_today := public.booking_business_date(clock_timestamp() at time zone 'Asia/Taipei',
    v_settings.work_start_time,v_settings.work_end_time);
  if new.booking_date < v_today + coalesce(v_settings.min_advance_days,0) then raise exception 'BOOKING_TOO_EARLY'; end if;
  if coalesce(v_settings.max_advance_days,0) > 0
     and new.booking_date > v_today + v_settings.max_advance_days then raise exception 'BOOKING_TOO_FAR'; end if;
  return new;
end; $function$
;

CREATE OR REPLACE FUNCTION public.enforce_booking_live_clock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.receipt_submission_id is not null and exists (
    select 1 from public.booking_receipts r
    where r.receipt_id=new.receipt_submission_id and r.member_id=new.member_id
      and r.submission_mode='accessible' and r.status in ('awaiting_review','bound')
  ) then return new; end if;
  if new.status in ('pending','confirmed') and
     (new.booking_date + new.start_time + (case when new.starts_next_day then interval '1 day' else interval '0 days' end))
       <= (clock_timestamp() at time zone 'Asia/Taipei') then
    raise exception 'BOOKING_TIME_PASSED';
  end if;
  return new;
end; $function$
;

CREATE OR REPLACE FUNCTION public.prevent_booking_on_active_holiday()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.receipt_submission_id is not null and exists (
    select 1 from public.booking_receipts r
    where r.receipt_id=new.receipt_submission_id and r.member_id=new.member_id
      and r.submission_mode='accessible' and r.status in ('awaiting_review','bound')
  ) then return new; end if;
  if exists (
    select 1
    from public.calendar_items
    where item_type = 'holiday'
      and status = 'active'
      and starts_on <= new.booking_date
      and coalesce(ends_on, starts_on) >= new.booking_date
  ) then
    raise exception 'BOOKING_HOLIDAY';
  end if;
  return new;
end;
$function$
;

create or replace function public.notify_booking_receipt_realtime_change()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
declare
  v_event_type text;
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;

  v_event_type := case new.status
    when 'awaiting_review' then 'booking.receipt.awaiting_review'
    when 'bound' then 'booking.receipt.bound'
    when 'failed' then 'booking.receipt.failed'
    when 'deleted' then 'booking.receipt.deleted'
    else null
  end;

  if v_event_type is not null then
    perform public.emit_realtime_invalidation(case when new.submission_mode='accessible' then array['admin','member'] else array['admin'] end, v_event_type);
  end if;

  return new;
end;
$function$;


notify pgrst, 'reload schema';
commit;
