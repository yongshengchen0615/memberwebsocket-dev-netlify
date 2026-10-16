-- Keep booking LINE notifications enabled after the transport, channel tokens and dispatch secret are configured.
-- The one-click public data reset intentionally preserves this private configuration row.
update booking_notifications.config
set enabled = true
where id = true;
