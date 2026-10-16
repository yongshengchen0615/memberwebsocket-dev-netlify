-- The sync only stages tomorrow's reminders; delivery still follows next_attempt_at.
select cron.schedule(
  'sync-booking-day-before-reminders',
  '*/5 * * * *',
  'select booking_notifications.sync_day_before_reminders();'
);
