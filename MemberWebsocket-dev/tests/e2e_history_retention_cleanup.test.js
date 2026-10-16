const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const file = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const migration = file('supabase/migrations/20261010030000_e2e_purge_history_option_and_qa_provenance.sql');
const api = file('supabase/functions/test-control-api/index.ts');
const client = file('admin/test-control.js');
const html = file('admin/index.html');

test('purge UI defaults to history retention and passes an explicit boolean', () => {
  assert.match(html, /id="keepTestHistoryOnPurge" type="checkbox" checked/);
  assert.match(html, /保留 E2E 測試紀錄與失敗快照/);
  assert.match(client, /keepTestHistory = els\.keepTestHistoryOnPurge\?\.checked !== false/);
  assert.match(client, /request\('admin\.test-control\.purge-test-data', \{ keepTestHistory \}\)/);
  assert.match(client, /if \(!keepTestHistory\) \{[\s\S]*member-admin-test-history-cleared/);
  assert.match(client, /purge\.historyRetained === true/);
});

test('edge API validates retention and preserves screenshots only when requested', () => {
  assert.match(api, /typeof body\.keepTestHistory !== "boolean"/);
  assert.match(api, /keepTestHistory = body\.keepTestHistory !== false/);
  assert.match(api, /admin_purge_all_test_data_converged", \{ p_keep_history: keepTestHistory \}/);
  assert.match(api, /keepTestHistory \? 0 : await purgeE2EArtifactStorage\(supabase\)/);
  assert.match(api, /historyRetained: keepTestHistory/);
  assert.match(api, /requireActiveAdminContract/);
  assert.match(api, /TEST_RUN_ACTIVE/);
});

test('retention-aware SQL purges test business data and protects QA run history', () => {
  assert.match(migration, /FUNCTION public\.admin_purge_test_data\(p_keep_history boolean\)/i);
  assert.match(migration, /if not p_keep_history then\s+delete from public\.automation_test_runs/i);
  assert.match(migration, /FUNCTION public\.admin_purge_all_test_data\(p_keep_history boolean\)/i);
  assert.match(migration, /if not p_keep_history then\s+delete from public\.e2e_evolution_state/i);
  assert.match(migration, /FUNCTION public\.admin_purge_all_test_data_converged\(p_keep_history boolean\)/i);
  assert.match(migration, /public\.admin_purge_test_data\(p_keep_history\)/i);
  assert.match(migration, /public\.admin_purge_all_test_data\(p_keep_history\)/i);
  assert.match(migration, /TEST_EXECUTION_ACTIVE/);
  assert.match(migration, /TEST_DATA_CROSS_BOUNDARY_POINT_TRANSFER/);
  assert.match(migration, /TEST_DATA_CROSS_BOUNDARY_REFERRAL/);
  for (const fn of ['admin_purge_test_data', 'admin_purge_all_test_data', 'admin_purge_all_test_data_converged']) {
    assert.match(migration, new RegExp('revoke all on function public\\.' + fn + '\\(boolean\\) from public, anon, authenticated'));
    assert.match(migration, new RegExp('grant execute on function public\\.' + fn + '\\(boolean\\) to service_role'));
  }
});

test('runtime QA cleanup uses one provenance definition for qa, qa-ui, qa-state', () => {
  assert.match(migration, /FUNCTION public\.admin_recycle_e2e_runtime\(p_lease_id uuid, p_actor text\)/i);
  assert.match(migration, /public\.is_qa_test_provenance\(c\.created_by\)/);
  assert.match(migration, /public\.is_qa_test_provenance\(e\.created_by\)/);
  assert.match(migration, /public\.is_qa_test_provenance\(pc\.created_by\)/);
  assert.match(migration, /public\.is_qa_test_provenance\(tt\.created_by\)/);
  assert.doesNotMatch(migration, /created_by like 'qa:%'/i);
  assert.match(migration, /E2E_RECYCLE_QA_ARTIFACTS_REMAIN/);
  assert.match(migration, /v_remaining <> 0/);
  assert.match(migration, /revoke all on function public\.admin_recycle_e2e_runtime\(uuid, text\)/i);
});

test('pre-run recycle releases QA-owned primary technician dependency before cleanup', () => {
  const runtime = file('supabase/migrations/20261010031500_restore_primary_technician_before_e2e_recycle.sql');
  assert.match(runtime, /v_system_primary_technician_id uuid/);
  assert.match(runtime, /booking_settings bs[\s\S]*is_qa_test_provenance\(t\.created_by\)/);
  assert.match(runtime, /created_by\)\s+values \('系統主要技師', true, 0, 'system'\)/);
  const restore = runtime.indexOf("updated_by = 'qa:e2e:recycle'");
  const cleanup = runtime.indexOf("for v_pass in 1..4 loop");
  assert.ok(restore > 0 && cleanup > restore, 'primary technician must be restored before QA cleanup');
  assert.match(runtime, /E2E_RECYCLE_QA_ARTIFACTS_REMAIN/);
  assert.match(runtime, /TEST_DATA_CROSS_BOUNDARY_POINT_TRANSFER/);
  assert.match(runtime, /TEST_DATA_CROSS_BOUNDARY_REFERRAL/);
});
