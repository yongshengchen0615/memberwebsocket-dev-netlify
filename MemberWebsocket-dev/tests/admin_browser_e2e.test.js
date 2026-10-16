const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('admin exposes only the unified background full E2E entrypoint', () => {
  const html = read('admin/index.html');
  const runner = read('admin/e2e-control.js');
  assert.match(html, /e2e-control\.css\?v=[^"'\s]+/);
  assert.match(html, /e2e-control\.js\?v=qa-e2e-\d{8}-\d+/);
  assert.match(runner, /runPairedFullE2EButton/);
  assert.match(runner, /模組 E2E · 後端 QA \+ 管理端 ↔ 用戶端協同/);
  assert.match(runner, /stopAdminE2EButton/);
  assert.match(runner, /requestStop/);
  for (const removed of [
    'runAdminQuickE2EButton',
    'runAdminFullE2EButton',
    'runBookingPendingE2EButton',
    'runBookingCancellationE2EButton',
    'runBookingFullE2EButton',
    '管理端快速 E2E',
    '管理端完整 E2E',
    '待確認 E2E',
    '取消申請 E2E',
    '預約完整協同 E2E'
  ]) assert.doesNotMatch(runner, new RegExp(removed));
  assert.match(runner, /ADMIN_TEST_MEMBER_PROFILE_EDIT/);
  assert.match(runner, /ADMIN_POINT_CARD_CRUD/);
  assert.match(runner, /ADMIN_EVENT_TICKET_CRUD/);
  assert.match(runner, /ADMIN_CALENDAR_CRUD/);
  assert.match(runner, /ADMIN_BOOKING_CRUD/);
  assert.match(runner, /ADMIN_BUTTON_COVERAGE/);
  assert.match(runner, /startUnifiedBackgroundE2E/);
  assert.match(runner, /runUnifiedBackground/);
  assert.match(runner, /e2eBackgroundRunner/);
  assert.match(runner, /openBackgroundRunnerWindow/);
  assert.match(runner, /openClientWindows\(selectedClientSurfaces\(selectedModules\)\.length \? participantCount : 0, false, mobileViewport\)/);
  assert.match(runner, /receiveBackgroundStatus/);
  assert.match(runner, /backgroundAwareTimeout/);
  assert.doesNotMatch(html, /id="runQuickAutomationTestButton"/);
  assert.doesNotMatch(html, /id="runFullAutomationTestButton"/);
});

test('paired runner covers every member-facing surface and verifies admin record sync', () => {
  const runner = read('admin/e2e-control.js');
  for (const surface of ['member', 'points', 'event', 'calendar', 'booking']) {
    assert.match(runner, new RegExp("\\['" + surface + "',"));
  }
  assert.match(runner, /MemberUserTestControl/);
  assert.match(runner, /runFull\(\)/);
  assert.match(runner, /runParticipantSurfaces/);
  assert.match(runner, /runPairedAdminBookingLive/);
  assert.match(runner, /waitForLivePairedBookingTarget/);
  assert.match(runner, /pairedBookingCandidates\(data, participant, \{ live: true \}\)/);
  assert.match(runner, /let pairedAdminBookingChain = Promise\.resolve\(\)/);
  assert.match(runner, /participant\.bookingResult = child/);
  assert.match(runner, /pairedAdminBookingChain = queued\.catch\(\(\) => null\)/);
  assert.match(runner, /await participant\.adminBookingTask/);
  assert.match(runner, /await clientExecution;/);
  assert.doesNotMatch(runner, /liveAdminTasks/);
  assert.match(runner, /waitForPairedBookingHandoff/);
  assert.doesNotMatch(runner, /Promise\.all\(\[adminTask, \.\.\.clientTasks\]\)/);
  assert.match(runner, /_ADMIN_RECORD_SYNC/);
  assert.match(runner, /data-record-filter="testAutomation"/);
  assert.match(runner, /member-test-session-v1/);
  assert.match(runner, /MAX_PAIRED_PARTICIPANTS = 10/);
  assert.match(runner, /function openClientWindows\(/);
  assert.match(runner, /member-e2e-\$\{stamp\}-\$\{index \+ 1\}/);
  assert.match(runner, /popup=yes/);
  assert.match(runner, /CLIENT_MOBILE_VIEWPORT = Object\.freeze\(\{ width: 430, height: 932 \}\)/);
  assert.match(runner, /pairedE2EMobileViewport/);
  assert.match(runner, /1 Runner/);
  assert.doesNotMatch(runner, /openClientWindowGroups|clientWindowGroupReady|clientWindowGroups|5 Runner/);
  assert.match(runner, /pairedE2EAccountCount/);
  const e2eCss = read('admin/e2e-control.css');
  assert.match(e2eCss, /\.admin-e2e-paired-config\s*\{[\s\S]*display:\s*grid/);
  assert.match(e2eCss, /grid-template-columns:\s*minmax\(190px, max-content\) minmax\(0, 1fr\)/);
  assert.match(e2eCss, /\.admin-e2e-paired-config small\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(e2eCss, /@media \(max-width: 860px\)[\s\S]*\.admin-e2e-paired-config\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(runner, /admin\.test-mode\.bootstrap/);
  assert.match(runner, /admin\.test-mode\.save/);
  assert.match(runner, /E2E_REAL_MEMBER_BLOCKED/);
  assert.match(runner, /memberIsTestAccount/);
  assert.doesNotMatch(runner, /<iframe|adminBrowserE2EFrame|state\.frame|state\.viewport/);
  assert.match(runner, /e2eViewport/);
  assert.doesNotMatch(runner, /service_role|SUPABASE_SERVICE_ROLE_KEY/);
});

test('paired E2E account pool is server-filtered to test users and real-user mutation is blocked', () => {
  const runner = read('admin/e2e-control.js');
  const testModeApi = read('supabase/functions/test-mode-api/index.ts');
  assert.match(testModeApi, /\.eq\("is_test_account", true\)/);
  assert.match(runner, /E2E_TEST_ROSTER_REQUIRED/);
  assert.match(runner, /E2E_REAL_MEMBER_BLOCKED/);
  assert.match(runner, /memberIsTestAccount/);
  assert.match(runner, /prepareTestAccounts\(participantCount, preferredMemberIds\)/);
});

test('user E2E returns structured results to the paired admin runner', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /const VERSION = '2026-10-\d{2}\.\d+'/);
  assert.match(runner, /browserRun: state\.browserRun \|\| null/);
  assert.match(runner, /stop: \(\) => requestStop\(\)/);
  assert.match(runner, /pairedLaneIndex/);
  assert.match(runner, /bookingLaneDayCount/);
  assert.match(runner, /slotLane = Math\.floor\(pairedLaneIndex\(\) \/ dayCount\)/);
  assert.match(runner, /summary: \{/);
  assert.match(runner, /results: state\.results\.map/);
});

test('test control API records browser results only behind admin authorization', () => {
  const api = read('supabase/functions/test-control-api/index.ts');
  const authIndex = api.indexOf('await requireActiveAdminContract({');
  const actionIndex = api.indexOf('if (action === "admin.test-control.record-browser-run")', authIndex);
  assert.ok(authIndex >= 0 && actionIndex > authIndex);
  assert.match(api, /\["admin-browser", "paired-browser"\]\.includes\(runnerKind\)/);
  assert.match(api, /const runnerKind = asText\(body\.runnerKind, 40\)/);
  assert.match(api, /is_test_account !== true/);
  assert.match(api, /BROWSER_E2E_FAILED/);
  assert.match(api, /automation_test_runs/);
  assert.match(api, /automation_test_cases/);
  assert.match(api, /automation_test_steps/);
});


test('test data is retained until an admin manually purges it', () => {
  const html = read('admin/index.html');
  const control = read('admin/test-control.js');
  const api = read('supabase/functions/test-control-api/index.ts');
  const userRunner = read('user-test-control.js');
  const adminRunner = read('admin/e2e-control.js');
  const migration = read('supabase/migrations/20260922055500_preserve_test_data_manual_purge.sql');

  assert.match(html, /id="purgeTestDataButton"/);
  assert.match(html, /測試資料與測試紀錄分開管理/);
  assert.match(html, /id="keepTestHistoryOnPurge"/);
  assert.match(control, /admin\.test-control\.purge-test-data/);
  assert.match(control, /測試帳號與測試模式環境設定會保留/);
  assert.match(api, /action === "admin\.test-control\.purge-test-data"/);
  assert.match(api, /await requireActiveAdminContract\(\{/);
  assert.match(api, /admin_purge_all_test_data/);

  assert.match(userRunner, /action: 'user\.qa\.fixture\.cleanup', surface: otherSurface, testSessionToken: token/);
  assert.doesNotMatch(userRunner, /qaServiceRequest\('user\.qa\.fixture\.cleanup'/);
  assert.doesNotMatch(userRunner, /mutationQaCase\('POINT_TICKET_WRITE'\)/);
  assert.doesNotMatch(userRunner, /mutationQaCase\('EVENT_TICKET_WRITE'\)/);
  assert.doesNotMatch(userRunner, /mutationQaCase\('BOOKING_WRITE'\)/);
  assert.doesNotMatch(userRunner, /mutationQaCase\('BOOKING_GROUP_WRITE'\)/);
  assert.match(adminRunner, /PAIRED_DEEP_RETENTION/);
  assert.match(adminRunner, /postTestAutoCleanupSkipped: true/);

  assert.match(migration, /create or replace function public\.admin_purge_test_data\(\)/);
  assert.match(migration, /where is_test_account = true/);
  assert.match(migration, /delete from public\.automation_test_runs/);
  assert.doesNotMatch(migration, /delete from public\.members/);
  assert.match(migration, /grant execute on function public\.admin_purge_test_data\(\)\s+to service_role/);
});


test('paired E2E creates complex admin fixtures before randomized user clients start', () => {
  const runner = read('admin/e2e-control.js');
  const migration = read('supabase/migrations/20260922063942_enhance_e2e_fixture_and_test_surface_sessions_v2.sql');

  const fixtureCall = runner.indexOf('await prepareComplexE2EFixtures(profile, cleanupLeaseId)');
  const accountCall = runner.indexOf('await prepareTestAccounts(participantCount, preferredMemberIds)');
  const clientStart = runner.indexOf('runParticipantSurfaces(participant)');
  assert.ok(fixtureCall >= 0 && accountCall > fixtureCall && clientStart > fixtureCall);

  assert.match(runner, /replaySource\?replaySurfacePlan\(replaySource\.surfacePlan,selectedModules\):weightedSurfacePlan\(profile,index\+1\)/);
  assert.match(runner, /runWithConcurrency/);
  assert.match(runner, /randomInt\(60, 420 \+ state\.complexityLevel \* 80\)/);
  assert.match(runner, /createPairedSession\(participant\.account, surface\)/);
  assert.match(runner, /admin\.test-control\.prepare-e2e-fixtures/);

  assert.match(migration, /admin_prepare_complex_e2e_fixtures/);
  assert.match(migration, /birthday_month/);
  assert.match(migration, /yearly/);
  assert.match(migration, /monthly/);
  assert.match(migration, /weekly/);
  assert.match(migration, /month_end/);
  assert.match(migration, /week_end/);
  assert.match(migration, /days_after_issue/);
  assert.match(migration, /fixed_date/);
  assert.match(migration, /array\['general','silver','gold','platinum'\]/);
  assert.match(migration, /jsonb_build_array\(2,3,5,8,13,21\)/);
  assert.match(migration, /requires_companion_service/);
});


test('paired booking E2E requires a configured primary technician before clients start', () => {
  const runner = read('admin/e2e-control.js');
  const migration = read('supabase/migrations/20260922072102_fix_e2e_booking_primary_technician.sql');

  assert.match(runner, /primaryTechnicianId/);
  assert.match(runner, /maxPartySize >= 2/);
  assert.match(runner, /primaryTechnicianConfigured: true/);
  assert.match(runner, /maxPartySizeAtLeast: 2/);
  assert.match(runner, /E2E_SURFACE_TIMEOUT/);
  assert.match(runner, /control\.stop\?\.\(\)/);

  assert.match(migration, /E2E QA 技師甲/);
  assert.match(migration, /primary_technician_id = v_primary_technician_id/);
  assert.match(migration, /max_party_size = greatest\(max_party_size,2\)/);
  assert.match(migration, /'primaryTechnicianId'/);
  assert.match(migration, /'maxPartySize'/);
});

test('browser E2E recording stays bounded as case detail grows', () => {
  const runner = read('admin/e2e-control.js');
  const api = read('supabase/functions/test-control-api/index.ts');
  assert.match(runner, /compactRecordSnapshot/);
  assert.match(runner, /byteLength > 320000/);
  assert.match(runner, /compactRecordPayload/);
  assert.match(runner, /E2E_RECORD_TOO_LARGE/);
  assert.match(api, /MAX_REQUEST_BYTES = 384_000/);
  assert.match(api, /STANDARD_REQUEST_BYTES = 20_000/);
  assert.match(api, /action !== "admin\.test-control\.record-browser-run"/);
});
