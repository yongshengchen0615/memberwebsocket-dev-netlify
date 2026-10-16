const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase/migrations/20260930040000_reduce_booking_reminder_sync_polling.sql'),
  'utf8',
);

test('day-before reminder sync reduces empty polling without changing staging semantics', () => {
  assert.match(migration, /cron\.schedule\(\s*'sync-booking-day-before-reminders'/s);
  assert.match(migration, /'\*\/5 \* \* \* \*'/);
  assert.match(migration, /select booking_notifications\.sync_day_before_reminders\(\);/);
  assert.doesNotMatch(migration, /\b(?:update|insert\s+into|delete\s+from)\s+cron\.job\b/i);
  assert.doesNotMatch(migration, /cron\.unschedule/i);
});
