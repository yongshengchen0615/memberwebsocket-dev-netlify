create or replace function public.automation_test_notification_snapshot()
returns jsonb
language sql
security invoker
set search_path = public, booking_notifications, pg_temp
as $$
  select jsonb_build_object(
    'scheduledGrantMessages',
      (select count(*)::integer
         from public.scheduled_grant_messages s
         join public.members m on m.id = s.member_id
        where m.is_test_account = true),
    'bookingOutboxMessages',
      (select count(*)::integer
         from booking_notifications.outbox o
         join public.bookings b on b.id = o.booking_id
         join public.members m on m.id = b.member_id
        where m.is_test_account = true),
    'testRecipientOutboxMessages',
      (select count(*)::integer
         from booking_notifications.outbox o
        where o.recipient like 'TEST-%')
  );
$$;

revoke all on function public.automation_test_notification_snapshot()
  from public, anon, authenticated;
grant execute on function public.automation_test_notification_snapshot()
  to service_role;
