const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261101040000_restore_platform_business_runtime.sql'),'utf8');
test('tenant scheduler recovery names only the tenant runtime and uses cron.alter_job',()=>{
  assert.match(migration, /platform-business-runtime/);
  assert.match(migration, /cron\.alter_job\s*\(/);
  assert.match(migration, /active\s*:=\s*true/);
  assert.doesNotMatch(migration, /cron\.alter_job\s*\([^;]*issue-fixed-tickets/s);
  assert.doesNotMatch(migration, /cron\.alter_job\s*\([^;]*dispatch-scheduled-grant-messages/s);
});
test('monitoring covers the business runtime schedule without exposing cron commands',()=>{
  assert.match(migration, /admin_e2e_automation_health/);
  assert.match(migration, /'platform-business-runtime',\s*interval\s*'5 minutes'/);
  assert.doesNotMatch(migration, /'command',\s*command/);
});
