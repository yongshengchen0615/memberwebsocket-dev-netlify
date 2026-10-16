create or replace function public.skip_booking_notification_for_test_member(
  p_id uuid,
  p_attempt integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row_count integer := 0;
begin
  update booking_notifications.outbox o
  set status = 'skipped',
      last_error = 'TEST_ACCOUNT_LINE_DISABLED'
  from public.bookings b
  join public.members m on m.id = b.member_id
  where o.id = p_id
    and o.booking_id = b.id
    and o.status = 'sending'
    and o.attempt_count = p_attempt
    and m.is_test_account = true;

  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
end;
$$;

revoke all on function public.skip_booking_notification_for_test_member(uuid, integer)
from public, anon, authenticated;

grant execute on function public.skip_booking_notification_for_test_member(uuid, integer)
to service_role;
