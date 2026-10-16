const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase/migrations/20260930050000_guard_scheduled_grant_dispatch.sql'),
  'utf8',
);

test('scheduled grant dispatcher skips empty HTTP calls without delaying due work', () => {
  assert.match(migration, /cron\.schedule\(\s*'dispatch-scheduled-grant-messages'/s);
  assert.match(migration, /'\* \* \* \* \*'/);
  assert.match(migration, /net\.http_post\(/);
  assert.match(migration, /status\s*=\s*'pending'[\s\S]*scheduled_for\s*<=\s*now\(\)/);
  assert.match(migration, /status\s*=\s*'sending'[\s\S]*updated_at\s*<\s*now\(\)\s*-\s*interval\s*'10 minutes'/);
  assert.match(migration, /GRANT_MESSAGE_DISPATCH_SECRET/);
  assert.doesNotMatch(migration, /\b(?:update|insert\s+into|delete\s+from)\s+cron\.job\b/i);
  assert.doesNotMatch(migration, /cron\.unschedule/i);
});
