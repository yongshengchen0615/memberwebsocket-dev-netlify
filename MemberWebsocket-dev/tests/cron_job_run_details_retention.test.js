const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase/migrations/20260930030000_prune_cron_job_run_details.sql'),
  'utf8',
);

test('pg_cron history retention removes only completed records older than 14 days', () => {
  assert.match(migration, /cron\.schedule\(\s*'prune-cron-job-run-details'/s);
  assert.match(migration, /'43 19 \* \* \*'/);
  assert.match(migration, /delete\s+from\s+cron\.job_run_details/i);
  assert.match(migration, /end_time\s*<\s*now\(\)\s*-\s*interval\s*'14 days'/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bstart_time\s*</i);
  assert.doesNotMatch(migration, /\b(?:update|insert\s+into|delete\s+from)\s+cron\.job\b/i);
  assert.doesNotMatch(migration, /cron\.unschedule/i);
});
