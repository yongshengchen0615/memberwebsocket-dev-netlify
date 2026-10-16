const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase/migrations/20260930020000_reduce_booking_notification_dispatch_polling.sql'),
  'utf8',
);

test('booking notification polling reduces empty cron runs without changing dispatch semantics', () => {
  assert.match(migration, /cron\.schedule\(\s*'dispatch-booking-line-notifications'/s);
  assert.match(migration, /'15 seconds'/);
  assert.match(migration, /select booking_notifications\.dispatch\(20\);/);
  assert.doesNotMatch(migration, /\b(?:update|insert\s+into|delete\s+from)\s+cron\.job\b/i);
  assert.doesNotMatch(migration, /cron\.unschedule/i);
});
