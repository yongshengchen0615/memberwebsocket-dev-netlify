const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20260925155000_schedule_realtime_event_retention.sql'),
  'utf8',
);

test('realtime event retention is removed from the insert write path', () => {
  assert.match(migration, /drop trigger if exists realtime_events_prune_after_insert on public\.realtime_events/i);
  assert.doesNotMatch(migration, /create\s+trigger\s+realtime_events_prune_after_insert/i);
});

test('realtime event retention stays bounded by a scheduled seven-day prune', () => {
  assert.match(migration, /create function public\.prune_realtime_events\(\)/i);
  assert.match(migration, /created_at < clock_timestamp\(\) - interval '7 days'/i);
  assert.match(migration, /cron\.schedule\([\s\S]*realtime-events-retention-hourly[\s\S]*17 \* \* \* \*/i);
  assert.match(migration, /select public\.prune_realtime_events\(\)/i);
});

test('realtime event retention helper is not exposed to clients', () => {
  assert.match(migration, /revoke all on function public\.prune_realtime_events\(\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.prune_realtime_events\(\) to service_role/i);
});
