select cron.schedule(
  'dispatch-booking-line-notifications',
  '5 seconds',
  'select booking_notifications.dispatch(20);'
);
