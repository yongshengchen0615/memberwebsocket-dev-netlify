const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('admin test control center is a result surface for the unified full E2E', () => {
  const html = read('admin/index.html');
  const client = read('admin/test-control.js');
  const e2e = read('admin/e2e-control.js');
  const css = read('admin/test-control.css');

  assert.match(html, /test-control\.css\?v=[^"']+/);
  assert.match(html, /test-control\.js\?v=test-control-[A-Za-z0-9._-]+/);
  assert.match(html, /id="automationTestTitle"/);
  assert.doesNotMatch(html, /id="runQuickAutomationTestButton"/);
  assert.doesNotMatch(html, /id="runFullAutomationTestButton"/);
  assert.match(html, /id="automationTestCaseList"/);
  assert.match(html, /id="automationTestHistoryList"/);
  assert.match(html, /後端完整 QA 已整合/);
  assert.match(html, /Expected/);
  assert.match(html, /Actual/);
  assert.match(css, /\.test-control-data-grid/);
  const workspace = read('admin/test-workspace-tabs.js');
  const workspaceCss = read('admin/test-workspace-tabs.css');
  for (const key of ['environment', 'accounts', 'runner', 'history']) {
    assert.match(workspace, new RegExp("key: '" + key + "'"));
  }
  assert.match(workspace, /環境設定/);
  assert.match(workspace, /測試帳號/);
  assert.match(workspace, /E2E 執行/);
  assert.match(workspace, /測試紀錄/);
  assert.match(workspace, /settingsCard/);
  assert.match(workspace, /accountsCard/);
  assert.match(workspaceCss, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(workspaceCss, /test-workspace-panel--accounts/);

  assert.match(client, /\/functions\/v1\/test-control-api/);
  assert.match(client, /admin\.test-control\.create/);
  assert.match(client, /admin\.test-control\.execute/);
  assert.match(client, /admin\.test-control\.status/);
  assert.match(client, /window\.MemberAdminTestControl = Object\.freeze/);
  assert.match(client, /runFull: \(selectedModules\) => startRun\('full', \{ rethrow: true, selectedModules \}\)/);
  assert.match(client, /window\.setInterval\(tick, 900\)/);
  assert.match(e2e, /runUnifiedServerFullPhase/);
  assert.match(e2e, /window\.MemberAdminTestControl/);
  assert.match(e2e, /await control\.runFull\(selectedModules\)/);
  assert.doesNotMatch(client, /service[_-]?role/i);
});

test('test control API requires admin identity and records observable cases', () => {
  const api = read('supabase/functions/test-control-api/index.ts');

  assert.match(api, /verifyLineIdTokenContract/);
  assert.match(api, /requireActiveAdminContract/);
  assert.match(api, /LINE_ADMIN_CHANNEL_ID/);
  assert.match(api, /automation_test_runs/);
  assert.match(api, /automation_test_cases/);
  assert.match(api, /automation_test_steps/);
  assert.match(api, /ENVIRONMENT_ACCESS/);
  assert.match(api, /TEST_ACCOUNT_INTEGRITY/);
  assert.match(api, /MEMBERSHIP_TERMS_READY/);
  assert.match(api, /MEMBERSHIP_TERMS_NOT_CONFIGURED/);
  assert.match(api, /activeRequiredTermsAtLeast: 1/);
  assert.match(api, /SESSION_SECURITY/);
  assert.match(api, /POINTS_INTEGRITY/);
  assert.match(api, /FIXED_TICKET_INTEGRITY/);
  assert.match(api, /LINE_SUPPRESSION/);
  assert.match(api, /BOOKING_INTEGRITY/);
  assert.match(api, /PRESENCE_INTEGRITY/);
  assert.match(api, /settingsRowPresent/);
  assert.match(api, /settingsFlagsValid/);
  assert.match(api, /activeTestAccountsAtLeast: 1/);
  assert.doesNotMatch(api, /const ok = actual\.maintenanceEnabled && actual\.pcLoginEnabled/);
  assert.match(api, /維護模式與裝置測試登入開關可為關閉/);
  assert.match(api, /automation_test_notification_snapshot/);
  assert.match(api, /derivedBalanceMismatches/);
  assert.match(api, /effectiveActivePresenceSessions/);
  assert.match(api, /staleStorageRows/);
  assert.match(api, /activeThresholdMs = 90 \* 1000/);
  assert.doesNotMatch(api, /STALE_PRESENCE_SESSION/);
  assert.match(api, /overlappingTechnicianReservations/);
  assert.doesNotMatch(api, /actual:\s*\{[^}]*token_hash/s);
});

test('E2E test-account consent fixture cannot target production members', () => {
  const api = read('supabase/functions/test-control-api/index.ts');
  assert.match(api, /admin\.test-control\.prepare-test-account-consents/);
  assert.match(api, /prepareTestAccountConsents/);
  assert.match(api, /row\.is_test_account === true/);
  assert.match(api, /TEST_MEMBER_SELECTION_FORBIDDEN/);
  assert.match(api, /membership_consents/);
  assert.match(api, /test_control\.test_consent\.prepare/);
  assert.match(api, /member_id,terms_id/);
});

test('booking LINE self-test validates production code without requiring a production booking fixture', () => {
  const api = read('supabase/functions/test-control-api/index.ts');
  const edge = read('supabase/functions/booking-line-notifications/index.ts');
  assert.match(edge, /contractSource = 'synthetic-contract'/);
  assert.match(edge, /contractSource = 'live-preview'/);
  assert.match(edge, /productionContract: true/);
  assert.match(edge, /【預約確認】/);
  assert.match(edge, /Clean\/reset environments intentionally have no production booking rows/);
  assert.match(edge, /const failed = await deliver/);
  assert.match(edge, /const retried = await deliver/);
  assert.match(api, /productionContract: data\.productionContract === true/);
  assert.match(api, /\["live-preview", "synthetic-contract"\]\.includes\(actual\.contractSource\)/);
  assert.doesNotMatch(api, /&& actual\.productionMember\s*&& actual\.flexType/);
});

test('test control persistence is service-role only with RLS enabled', () => {
  const schema = read('supabase/migrations/20260921012651_automation_test_control_center.sql');
  const notification = read('supabase/migrations/20260921012739_automation_test_notification_snapshot.sql');

  for (const table of ['automation_test_runs', 'automation_test_cases', 'automation_test_steps']) {
    assert.match(schema, new RegExp('alter table public\\.' + table + ' enable row level security'));
    assert.match(schema, new RegExp('revoke all on table public\\.' + table + ' from public, anon, authenticated'));
    assert.match(schema, new RegExp('grant select, insert, update, delete on table public\\.' + table + ' to service_role'));
  }

  assert.match(notification, /security invoker/);
  assert.match(notification, /booking_notifications\.outbox/);
  assert.match(notification, /m\.is_test_account = true/);
  assert.match(notification, /revoke all on function public\.automation_test_notification_snapshot\(\)/);
  assert.match(notification, /grant execute on function public\.automation_test_notification_snapshot\(\)[\s\S]*to service_role/);
  assert.doesNotMatch(notification, /security definer/);
});


test('purge refreshes admin cards, event tickets and fixed-ticket cache without manual reload', () => {
  const client = read('admin/test-control.js');
  const admin = read('admin/app.js');
  const fixed = read('admin/fixed-ticket-admin.js');

  assert.match(client, /MemberAdminDataSync\?\.refresh/);
  assert.match(client, /await window\.MemberAdminDataSync\.refresh\(\)/);
  assert.match(client, /new CustomEvent\('test-data-purged'/);
  assert.match(admin, /window\.MemberAdminDataSync = Object\.freeze/);
  assert.match(admin, /refresh: \(\) => refreshData\(false\)/);
  assert.match(fixed, /addEventListener\('test-data-purged'/);
  assert.match(fixed, /templates = \[\]/);
  assert.match(fixed, /renderFixedList\(\)/);
});


test('test control uses the single-request converged purge RPC', () => {
  const api = read('supabase/functions/test-control-api/index.ts');
  assert.match(api, /admin_purge_all_test_data_converged/);
  assert.doesNotMatch(api, /rpc\("admin_purge_all_test_data"\)/);
});
