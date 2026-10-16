begin;

create or replace function public.prepare_booking_receipt_request(
  p_booking_id uuid,
  p_member_id uuid,
  p_request_id text,
  p_object_path text,
  p_mime_type text,
  p_size_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_booking public.bookings%rowtype;
  v_existing public.booking_receipts%rowtype;
  v_receipt public.booking_receipts%rowtype;
begin
  p_request_id:=btrim(coalesce(p_request_id,''));
  p_object_path:=btrim(coalesce(p_object_path,''));
  p_mime_type:=lower(btrim(coalesce(p_mime_type,'')));

  if p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then raise exception 'INVALID_REQUEST_ID'; end if;
  if p_mime_type not in ('image/jpeg','image/png','image/webp','image/heic','image/heif') then raise exception 'RECEIPT_INVALID_MIME'; end if;
  if p_size_bytes is null or p_size_bytes<1 or p_size_bytes>5242880 then raise exception 'RECEIPT_FILE_TOO_LARGE'; end if;
  if p_object_path not like p_member_id::text||'/'||p_booking_id::text||'/%' then raise exception 'RECEIPT_INVALID_PATH'; end if;

  select * into v_booking
  from public.bookings
  where id=p_booking_id
  for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.member_id<>p_member_id then raise exception 'BOOKING_NOT_OWNED'; end if;
  if v_booking.status<>'confirmed' then raise exception 'INVALID_BOOKING_TRANSITION'; end if;
  if v_booking.cancellation_requested_at is not null and v_booking.cancellation_reviewed_at is null then
    raise exception 'BOOKING_CANCELLATION_PENDING';
  end if;

  select * into v_existing
  from public.booking_receipts
  where member_id=p_member_id and request_id=p_request_id
  for update;
  if found then
    if v_existing.booking_id<>p_booking_id
       or v_existing.declared_mime_type<>p_mime_type
       or v_existing.declared_size_bytes<>p_size_bytes then
      raise exception 'REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object(
      'receiptId',v_existing.receipt_id,
      'objectPath',v_existing.object_path,
      'status',v_existing.status,
      'alreadyPrepared',true,
      'replacedExisting',false
    );
  end if;

  select * into v_existing
  from public.booking_receipts
  where booking_id=p_booking_id and status='bound'
  for update;
  if found then raise exception 'BOOKING_ALREADY_COMPLETED_WITH_RECEIPT'; end if;

  select * into v_existing
  from public.booking_receipts
  where booking_id=p_booking_id and status='pending_upload'
  for update;
  if found then
    update public.booking_receipts
    set request_id=p_request_id,
        declared_mime_type=p_mime_type,
        declared_size_bytes=p_size_bytes,
        actual_mime_type=null,
        actual_size_bytes=null,
        sha256_hex=null,
        status='pending_upload',
        failure_reason='',
        bound_at=null,
        updated_at=now()
    where id=v_existing.id
    returning * into v_receipt;

    return jsonb_build_object(
      'receiptId',v_receipt.receipt_id,
      'objectPath',v_receipt.object_path,
      'status',v_receipt.status,
      'alreadyPrepared',false,
      'replacedExisting',true,
      'previousStatus','pending_upload'
    );
  end if;

  select * into v_existing
  from public.booking_receipts
  where booking_id=p_booking_id and status='awaiting_review'
  for update;
  if found then
    update public.booking_receipts
    set request_id=p_request_id,
        declared_mime_type=p_mime_type,
        declared_size_bytes=p_size_bytes,
        actual_mime_type=null,
        actual_size_bytes=null,
        sha256_hex=null,
        status='pending_upload',
        failure_reason='',
        bound_at=null,
        updated_at=now()
    where id=v_existing.id
    returning * into v_receipt;

    return jsonb_build_object(
      'receiptId',v_receipt.receipt_id,
      'objectPath',v_receipt.object_path,
      'status',v_receipt.status,
      'alreadyPrepared',false,
      'replacedExisting',true,
      'previousStatus','awaiting_review'
    );
  end if;

  insert into public.booking_receipts(
    receipt_id,booking_id,member_id,request_id,object_path,declared_mime_type,declared_size_bytes
  ) values(
    public.new_public_id('BR'),p_booking_id,p_member_id,p_request_id,p_object_path,p_mime_type,p_size_bytes
  )
  returning * into v_receipt;

  return jsonb_build_object(
    'receiptId',v_receipt.receipt_id,
    'objectPath',v_receipt.object_path,
    'status',v_receipt.status,
    'alreadyPrepared',false,
    'replacedExisting',false
  );
end;
$$;

revoke all on function public.prepare_booking_receipt_request(uuid,uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.prepare_booking_receipt_request(uuid,uuid,text,text,text,integer) to service_role;

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
    when 'pending_upload' then 'booking.receipt.pending_upload'
    when 'awaiting_review' then 'booking.receipt.awaiting_review'
    when 'bound' then 'booking.receipt.bound'
    when 'failed' then 'booking.receipt.failed'
    when 'deleted' then 'booking.receipt.deleted'
    else null
  end;

  if v_event_type is not null then
    perform public.emit_realtime_invalidation(array['admin'], v_event_type);
  end if;

  return new;
end;
$function$;

revoke all on function public.notify_booking_receipt_realtime_change() from public, anon, authenticated;
grant execute on function public.notify_booking_receipt_realtime_change() to service_role;

commit;
