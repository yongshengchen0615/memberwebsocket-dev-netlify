begin;

comment on table public.booking_receipts is
  'Private booking receipt snapshots. Bound receipts are retained for the lifecycle of the booking record; deleting the booking cascades the receipt row and enqueues the Storage object for deletion. Pending uploads older than 24 hours are expired and enqueued for cleanup.';

create or replace function public.expire_stale_booking_receipts()
returns integer
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    update public.booking_receipts
       set status='failed',
           failure_reason='stale-upload-expired',
           updated_at=now()
     where status='pending_upload'
       and created_at < now() - interval '24 hours'
     returning object_path
  loop
    insert into public.booking_receipt_cleanup_queue(object_path,reason)
    values(v_row.object_path,'stale-upload-expired')
    on conflict(object_path) do nothing;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.expire_stale_booking_receipts() from public,anon,authenticated;
grant execute on function public.expire_stale_booking_receipts() to service_role;

commit;
