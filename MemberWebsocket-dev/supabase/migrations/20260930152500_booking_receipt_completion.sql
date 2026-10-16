begin;

create table if not exists public.booking_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_id text not null unique,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  request_id text not null,
  storage_bucket text not null default 'booking-receipts',
  object_path text not null unique,
  declared_mime_type text not null,
  declared_size_bytes integer not null,
  actual_mime_type text,
  actual_size_bytes integer,
  sha256_hex text,
  status text not null default 'pending_upload',
  failure_reason text not null default '',
  bound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_receipts_request_id_check check (request_id ~ '^[A-Za-z0-9_-]{8,120}$'),
  constraint booking_receipts_bucket_check check (storage_bucket='booking-receipts'),
  constraint booking_receipts_mime_check check (declared_mime_type in ('image/jpeg','image/png','image/webp','image/heic','image/heif')),
  constraint booking_receipts_size_check check (declared_size_bytes between 1 and 5242880),
  constraint booking_receipts_status_check check (status in ('pending_upload','bound','failed','deleted')),
  constraint booking_receipts_sha256_check check (sha256_hex is null or sha256_hex ~ '^[a-f0-9]{64}$')
);

create unique index if not exists booking_receipts_member_request_unique
  on public.booking_receipts(member_id,request_id);
create unique index if not exists booking_receipts_one_pending_per_booking
  on public.booking_receipts(booking_id)
  where status='pending_upload';
create unique index if not exists booking_receipts_one_bound_per_booking
  on public.booking_receipts(booking_id)
  where status='bound';
create index if not exists booking_receipts_member_created_idx
  on public.booking_receipts(member_id,created_at desc);

alter table public.booking_receipts enable row level security;

create table if not exists public.booking_receipt_cleanup_queue (
  id bigserial primary key,
  object_path text not null unique,
  reason text not null default '',
  enqueued_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text not null default ''
);
alter table public.booking_receipt_cleanup_queue enable row level security;

create or replace function public.queue_booking_receipt_object_on_delete()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if old.status <> 'deleted' and nullif(old.object_path,'') is not null then
    insert into public.booking_receipt_cleanup_queue(object_path,reason)
    values(old.object_path,'receipt-row-deleted')
    on conflict(object_path) do nothing;
  end if;
  return old;
end;
$$;

drop trigger if exists booking_receipts_queue_object_on_delete on public.booking_receipts;
create trigger booking_receipts_queue_object_on_delete
after delete on public.booking_receipts
for each row execute function public.queue_booking_receipt_object_on_delete();

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'booking-receipts',
  'booking-receipts',
  false,
  5242880,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']::text[]
)
on conflict(id) do update set
  public=false,
  file_size_limit=5242880,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','image/heic','image/heif']::text[],
  updated_at=now();

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
  v_local_now timestamp := clock_timestamp() at time zone 'Asia/Taipei';
  v_end_at timestamp;
begin
  p_request_id:=btrim(coalesce(p_request_id,''));
  p_object_path:=btrim(coalesce(p_object_path,''));
  p_mime_type:=lower(btrim(coalesce(p_mime_type,'')));

  if p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then raise exception 'INVALID_REQUEST_ID'; end if;
  if p_mime_type not in ('image/jpeg','image/png','image/webp','image/heic','image/heif') then raise exception 'RECEIPT_INVALID_MIME'; end if;
  if p_size_bytes is null or p_size_bytes<1 or p_size_bytes>5242880 then raise exception 'RECEIPT_FILE_TOO_LARGE'; end if;
  if p_object_path not like p_member_id::text||'/'||p_booking_id::text||'/%' then raise exception 'RECEIPT_INVALID_PATH'; end if;

  select * into v_booking from public.bookings where id=p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.member_id<>p_member_id then raise exception 'BOOKING_NOT_OWNED'; end if;
  if v_booking.status<>'confirmed' then raise exception 'INVALID_BOOKING_TRANSITION'; end if;
  if v_booking.cancellation_requested_at is not null and v_booking.cancellation_reviewed_at is null then
    raise exception 'BOOKING_CANCELLATION_PENDING';
  end if;

  v_end_at:=coalesce(
    v_booking.end_at,
    v_booking.booking_date::timestamp + v_booking.end_time
      + case when v_booking.starts_next_day then interval '1 day' else interval '0 day' end
  );
  if v_end_at is null or v_local_now < v_end_at then raise exception 'BOOKING_NOT_FINISHED_YET'; end if;

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
      'alreadyPrepared',true
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
    if v_existing.created_at > now()-interval '15 minutes' then
      raise exception 'RECEIPT_UPLOAD_IN_PROGRESS';
    end if;
    update public.booking_receipts
    set status='failed',failure_reason='stale-upload-replaced',updated_at=now()
    where id=v_existing.id;
    insert into public.booking_receipt_cleanup_queue(object_path,reason)
    values(v_existing.object_path,'stale-upload-replaced')
    on conflict(object_path) do nothing;
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
    'alreadyPrepared',false
  );
end;
$$;

create or replace function public.complete_booking_with_receipt_request(
  p_receipt_id text,
  p_member_id uuid,
  p_actor_line_user_id text,
  p_expected_booking_updated_at timestamptz,
  p_actual_mime_type text,
  p_actual_size_bytes integer,
  p_sha256_hex text
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_receipt public.booking_receipts%rowtype;
  v_booking public.bookings%rowtype;
  v_settlement jsonb;
begin
  select * into v_receipt
  from public.booking_receipts
  where receipt_id=p_receipt_id
  for update;
  if not found then raise exception 'RECEIPT_NOT_FOUND'; end if;
  if v_receipt.member_id<>p_member_id then raise exception 'RECEIPT_NOT_OWNED'; end if;

  select * into v_booking
  from public.bookings
  where id=v_receipt.booking_id
  for update;
  if not found or v_booking.member_id<>p_member_id then raise exception 'BOOKING_NOT_OWNED'; end if;

  if v_receipt.status='bound' then
    select jsonb_build_object(
      'bookingId',s.booking_id,
      'serviceMinutes',s.service_minutes,
      'rewards',s.reward_details
    ) into v_settlement
    from public.booking_completion_settlements s
    where s.booking_id=v_booking.id;
    return jsonb_build_object(
      'receiptId',v_receipt.receipt_id,
      'bookingId',v_booking.id,
      'status','bound',
      'settlement',coalesce(v_settlement,'{}'::jsonb),
      'alreadyApplied',true
    );
  end if;
  if v_receipt.status<>'pending_upload' then raise exception 'RECEIPT_NOT_PENDING'; end if;
  if lower(coalesce(p_actual_mime_type,''))<>v_receipt.declared_mime_type then raise exception 'RECEIPT_MIME_MISMATCH'; end if;
  if p_actual_size_bytes is null or p_actual_size_bytes<1 or p_actual_size_bytes>5242880 then raise exception 'RECEIPT_FILE_TOO_LARGE'; end if;
  if p_actual_size_bytes<>v_receipt.declared_size_bytes then raise exception 'RECEIPT_SIZE_MISMATCH'; end if;
  if lower(coalesce(p_sha256_hex,'')) !~ '^[a-f0-9]{64}$' then raise exception 'RECEIPT_INVALID_HASH'; end if;

  update public.booking_receipts
  set actual_mime_type=lower(p_actual_mime_type),
      actual_size_bytes=p_actual_size_bytes,
      sha256_hex=lower(p_sha256_hex),
      updated_at=now()
  where id=v_receipt.id;

  v_settlement:=public.complete_booking_with_rewards_request(
    v_booking.id,
    p_expected_booking_updated_at,
    p_actor_line_user_id,
    ''
  );

  update public.booking_receipts
  set status='bound',bound_at=now(),failure_reason='',updated_at=now()
  where id=v_receipt.id;

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values(
    public.new_public_id('AUD'),p_actor_line_user_id,'member','user.booking.receipt.complete',
    'booking',v_booking.id::text,'success',
    jsonb_build_object(
      'receiptId',v_receipt.receipt_id,
      'objectPath',v_receipt.object_path,
      'mimeType',lower(p_actual_mime_type),
      'sizeBytes',p_actual_size_bytes,
      'sha256',lower(p_sha256_hex)
    )
  );

  return jsonb_build_object(
    'receiptId',v_receipt.receipt_id,
    'bookingId',v_booking.id,
    'status','bound',
    'settlement',v_settlement,
    'alreadyApplied',false
  );
end;
$$;

create or replace function public.fail_booking_receipt_request(
  p_receipt_id text,
  p_member_id uuid,
  p_actor_line_user_id text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_receipt public.booking_receipts%rowtype;
begin
  select * into v_receipt
  from public.booking_receipts
  where receipt_id=p_receipt_id and member_id=p_member_id
  for update;
  if not found then return; end if;
  if v_receipt.status='bound' then return; end if;

  update public.booking_receipts
  set status='failed',failure_reason=left(coalesce(p_reason,''),120),updated_at=now()
  where id=v_receipt.id;

  insert into public.booking_receipt_cleanup_queue(object_path,reason)
  values(v_receipt.object_path,left(coalesce(p_reason,'failed'),120))
  on conflict(object_path) do nothing;

  insert into public.audit_logs(
    audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail
  ) values(
    public.new_public_id('AUD'),p_actor_line_user_id,'member','user.booking.receipt.complete',
    'booking',v_receipt.booking_id::text,'failure',
    jsonb_build_object('receiptId',v_receipt.receipt_id,'reason',left(coalesce(p_reason,''),120))
  );
end;
$$;

revoke all on function public.prepare_booking_receipt_request(uuid,uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.prepare_booking_receipt_request(uuid,uuid,text,text,text,integer) to service_role;
revoke all on function public.complete_booking_with_receipt_request(text,uuid,text,timestamptz,text,integer,text) from public,anon,authenticated;
grant execute on function public.complete_booking_with_receipt_request(text,uuid,text,timestamptz,text,integer,text) to service_role;
revoke all on function public.fail_booking_receipt_request(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.fail_booking_receipt_request(text,uuid,text,text) to service_role;

commit;
