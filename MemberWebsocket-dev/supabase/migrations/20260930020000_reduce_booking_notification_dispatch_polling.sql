-- The dispatcher exits immediately when no due outbox rows exist, but pg_cron still
-- records every invocation. Moving from 5s to 15s cuts empty polling and run-history
-- writes by about two thirds while keeping notification delivery near-real-time.
select cron.schedule(
  'dispatch-booking-line-notifications',
  '15 seconds',
  'select booking_notifications.dispatch(20);'
);
