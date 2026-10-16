alter table booking_notifications.outbox add column if not exists coalesce_key text;

create unique index if not exists booking_notifications_pending_coalesce
  on booking_notifications.outbox(coalesce_key, channel, recipient)
  where status = 'pending'
    and attempt_count = 0
    and first_attempt_at is null
    and coalesce_key is not null;
