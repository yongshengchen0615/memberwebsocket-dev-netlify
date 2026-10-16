const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('admin exposes only maintenance and device login controls', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const testMode = read('admin/test-mode.js');

  assert.match(html, /id="testModeTab"/);
  assert.match(html, /id="testModePanel"/);
  assert.match(html, /id="systemMaintenanceEnabled"/);
  assert.doesNotMatch(html, /id="testModeEnabled"/);
  assert.match(html, /id="testModePcLoginEnabled"/);
  assert.match(html, /id="testModeMobileLoginEnabled"/);
  assert.match(html, /id="testModeDuplicateLoginEnabled"/);
  assert.doesNotMatch(html, /id="testModeAdminLoginEnabled"/);
  assert.doesNotMatch(html, /允許管理員登入用戶端/);
  assert.match(html, /id="systemMaintenanceBadge"/);
  assert.match(html, /id="testModePcLoginBadge"/);
  assert.match(html, /id="testModeMobileLoginBadge"/);
  assert.match(html, /id="testModeMaintenanceMessage"/);
  assert.match(html, /id="testModeAddAccountCount"/);
  assert.match(html, /test-mode\.js\?v=test-login-takeover-20261008-2/);
  assert.match(html, /test-mode\.css\?v=test-mode-ui-20260920-3/);
  assert.match(app, /switchPanel\('testMode'\)/);
  assert.match(testMode, /admin\.test-mode\.save/);
  assert.match(testMode, /admin\.test-mode\.bootstrap/);
  assert.doesNotMatch(testMode, /allowAdminUserLogin|testModeAdminLogin/);
  assert.match(testMode, /PC 測試登入：可用/);
  assert.match(testMode, /行動裝置測試登入：可用/);
  assert.match(testMode, /allowPcTestLogin/);
  assert.match(testMode, /allowMobileTestLogin/);
  assert.match(testMode, /allowDuplicateTestLogin/);
  assert.match(testMode, /maintenanceEnabled/);
  assert.doesNotMatch(testMode, /testModeEnabled|settings\.enabled|enabled: els\.testModeEnabled/);
  assert.match(html, /data-test-account-count="5"/);
  assert.match(testMode, /test-account-avatar/);
});

test('all member-facing surfaces load the direct test-account client before app logic', () => {
  for (const entry of [
    'member/index.html',
    'points/index.html',
    'event/index.html',
    'calendar/index.html',
    'booking/index.html',
  ]) {
    const html = read(entry);
    const clientMarker = '../test-mode-client.js?v=';
    const appMarker = entry === 'booking/index.html' ? './common.js?v=' : '../member-system.js?v=';
    const clientIndex = html.indexOf(clientMarker);
    const appIndex = html.indexOf(appMarker);
    assert.ok(clientIndex >= 0, `${entry}: missing test-mode-client.js cache-busted asset`);
    assert.ok(appIndex >= 0, `${entry}: missing application bootstrap asset`);
    assert.ok(clientIndex < appIndex, `${entry}: test-mode-client.js must load before application bootstrap`);
    assert.match(html, /test-mode\.css\?v=[^"']+/, entry);
  }

  const client = read('test-mode-client.js');
  const core = read('member-system.js');
  assert.match(client, /action: 'test-mode\.accounts'/);
  assert.match(client, /action: 'test-mode\.login'/);
  assert.doesNotMatch(client, /allowAdminUserLogin|ADMIN_REQUIRED/);
  assert.match(client, /if \(!mode\.maintenanceEnabled\)/);
  assert.doesNotMatch(client, /mode\.enabled/);
  assert.match(client, /mode\.allowMobileTestLogin/);
  assert.match(client, /mode\.allowPcTestLogin/);
  assert.match(client, /isMobileDevice\(\)/);
  assert.match(client, /selector\(config, surface, accounts, allowDuplicateTestLogin = false\)/);
  assert.match(client, /renderAccountOptions\(select, currentAccounts, surface, duplicateLoginAllowed\)/);
  assert.match(core, /TestModeClient\.prepare/);
  assert.match(core, /TestModeClient\.payload/);
  assert.match(core, /TestModeClient\.clearSession/);
});

test('direct test login is server-side restricted to active test accounts', () => {
  const api = read('supabase/functions/test-mode-api/index.ts');
  const auth = read('supabase/functions/_shared/test-mode-auth.ts');

  const adminAuthCall = api.indexOf('const identity = await verifyLineIdToken');
  assert.ok(api.indexOf('if (action === "test-mode.accounts")') < adminAuthCall);
  assert.ok(api.indexOf('if (action === "test-mode.login")') < adminAuthCall);
  assert.match(api, /requireTestLoginEnabled\(supabase, request\)/);
  assert.match(api, /deviceClassForRequest\(request\)/);
  assert.match(api, /allow_pc_test_login/);
  assert.match(api, /allow_mobile_test_login/);
  assert.match(api, /allow_duplicate_test_login/);
  assert.match(api, /maintenance_enabled/);
  assert.match(api, /member\.is_test_account !== true/);
  assert.match(api, /member\.status !== "active"/);
  assert.match(api, /member\.membership_status !== "active"/);
  assert.doesNotMatch(api, /TEST_ADMIN_LOGIN_DISABLED/);
  assert.doesNotMatch(auth, /allow_admin_user_login|admin\.role|admin\.status/);
});

test('test sessions are short-lived, hashed at rest and support direct sessions', () => {
  const api = read('supabase/functions/test-mode-api/index.ts');
  const auth = read('supabase/functions/_shared/test-mode-auth.ts');
  const schema = read('supabase/migrations/20260920054312_test_mode_virtual_accounts.sql');
  const directMigration = read('supabase/migrations/20260920081507_test_mode_direct_login_sessions.sql');
  const deviceMigration = read('supabase/migrations/20260920092340_bind_test_sessions_to_device_class.sql');
  const surfaceMigration = read('supabase/migrations/20260922063942_enhance_e2e_fixture_and_test_surface_sessions_v2.sql');

  assert.match(api, /const TEST_SESSION_HOURS = 2/);
  assert.match(api, /p_token_hash: tokenHash/);
  assert.match(api, /sha256Hex\(token\)/);
  assert.match(api, /create_test_login_session_v3/);
  assert.doesNotMatch(api, /admin_line_user_id: identity\.lineUserId/);
  assert.match(api, /p_device_class: deviceClass/);

  assert.match(auth, /member\.is_test_account !== true/);
  assert.match(auth, /SYSTEM_MAINTENANCE/);
  assert.match(auth, /maintenance_enabled/);
  assert.match(auth, /allow_pc_test_login/);
  assert.match(auth, /allow_mobile_test_login/);
  assert.match(auth, /device_class/);
  assert.doesNotMatch(auth, /admin_line_user_id|ADMIN_REQUIRED|TEST_ADMIN_DISABLED/);

  assert.match(schema, /is_test_account boolean not null default false/);
  assert.match(schema, /token_hash text not null unique/);
  assert.match(schema, /revoke all on table public\.test_login_sessions from public, anon, authenticated/);
  assert.match(schema, /grant select, insert, update, delete on table public\.test_login_sessions to service_role/);
  assert.match(directMigration, /alter column admin_line_user_id drop not null/);
  assert.match(deviceMigration, /add column if not exists device_class text/);
  assert.match(deviceMigration, /device_class in \('pc', 'mobile'\)/);
  assert.match(surfaceMigration, /add column if not exists surface text/);
  assert.match(surfaceMigration, /create_test_login_session_v2/);
  assert.match(surfaceMigration, /TEST_SURFACE_ALREADY_ACTIVE/);
  assert.match(surfaceMigration, /pg_advisory_xact_lock/);
});

test('test members use an isolated roster while staying out of formal KPI counts', () => {
  const coreApi = read('supabase/functions/api/index.ts');
  assert.match(coreApi, /const isTestAccount = asText\(memberKind,10\).*=== "test"/);
  assert.match(coreApi, /\.eq\("is_test_account",isTestAccount\)/);
  assert.match(coreApi, /from\("members"\)\.select\("\*",\{ count:"exact",head:true \}\)\.eq\("is_test_account",false\)/);
});

test('booking API uses the shared direct test-session verifier', () => {
  const bookingApi = read('supabase/functions/booking-api/index.ts');
  const auth = read('supabase/functions/_shared/test-mode-auth.ts');
  assert.match(bookingApi, /resolveTestSession/);
  assert.match(bookingApi, /testSessionToken/);
  assert.doesNotMatch(auth, /TEST_ADMIN_DISABLED|admin_line_user_id|allow_admin_user_login/);
});

test('all user-side direct APIs enforce the same maintenance-aware test identity', () => {
  for (const relative of [
    'supabase/functions/pointcard-extension-api/index.ts',
    'supabase/functions/member-profile-api/index.ts',
    'supabase/functions/booking-contact-api/index.ts',
    'supabase/functions/booking-group-api/index.ts',
    'supabase/functions/booking-group-slots-api/index.ts',
    'supabase/functions/booking-cancellation-api/index.ts',
    'supabase/functions/booking-calendar-api/index.ts',
  ]) {
    assert.match(read(relative), /resolveUserTestIdentity/, relative);
  }
});

test('browser APIs either forward test sessions directly or use the shared member session broker', () => {
  for (const relative of [
    'points/pointcard-ticket-overview.js',
    'booking/common.js',
    'booking/group-booking.js',
    'booking/contact-details.js',
    'booking/member-ui.js',
    'booking/calendar-flow.js',
  ]) {
    assert.match(read(relative), /TestModeClient/, relative);
  }

  for (const relative of [
    'member/profile-extension.js',
    'member/profile-birthday-edit.js',
  ]) {
    const source = read(relative);
    assert.match(source, /MemberSystem/);
    assert.match(source, /getSession\('member'\)/);
    assert.doesNotMatch(source, /fetch\(/);
    assert.doesNotMatch(source, /getIDToken|window\.liff/);
  }

  const pointOverview = read('points/pointcard-ticket-overview.js');
  assert.match(pointOverview, /function hasMemberAuth\(\)/);
  assert.match(pointOverview, /getSessionToken/);
  assert.doesNotMatch(pointOverview, /if \(!state\.config \|\| !state\.idToken\)/);
});

test('test account creation remains admin-only and transactional', () => {
  const rpc = read('supabase/migrations/20260920054446_test_mode_admin_save_rpc.sql');
  const api = read('supabase/functions/test-mode-api/index.ts');
  const auth = read('supabase/functions/_shared/test-mode-auth.ts');
  assert.match(rpc, /create or replace function public\.admin_save_test_mode/);
  assert.match(rpc, /v_existing \+ v_count > 200/);
  assert.match(rpc, /is_test_account,/);
  assert.match(rpc, /revoke all on function public\.admin_save_test_mode/);
  assert.match(rpc, /from public, anon, authenticated/);
  assert.match(rpc, /grant execute on function public\.admin_save_test_mode/);
  assert.match(rpc, /to service_role/);
  assert.match(api, /admin_save_maintenance_test_access/);
  assert.doesNotMatch(api, /p_test_mode_enabled|body\.enabled|row\.enabled/);
  assert.match(api, /p_maintenance_enabled: asBoolean\(body\.maintenanceEnabled\)/);
  assert.match(api, /p_allow_pc_test_login: asBoolean\(body\.allowPcTestLogin\)/);
  assert.match(api, /p_allow_mobile_test_login: asBoolean\(body\.allowMobileTestLogin\)/);
  assert.doesNotMatch(auth, /settingsResult\.data\?\.enabled/);
  assert.match(api, /authorizeAdmin\(supabase, identity\)/);
});


test('test accounts support guarded single and batch removal', () => {
  const html = read('admin/index.html');
  const adminUi = read('admin/test-mode.js');
  const api = read('supabase/functions/test-mode-api/index.ts');
  const migration = read('supabase/migrations/20260920133911_complete_test_account_purge.sql');
  const schema = read('supabase/migrations/20260920054312_test_mode_virtual_accounts.sql');
  const qaPurge = read('supabase/migrations/20260921143500_purge_test_member_qa_history.sql');

  assert.match(html, /id="testModeSelectAllAccounts"/);
  assert.match(html, /id="deleteSelectedTestAccountsButton"/);
  assert.match(html, /id="testModeAccountActionMessage"/);
  assert.match(adminUi, /admin\.test-mode\.delete-accounts/);
  assert.match(adminUi, /data-test-account-delete/);
  assert.match(adminUi, /window\.confirm/);
  assert.match(adminUi, /所有相關測試資料/);
  assert.match(adminUi, /已完整移除/);
  assert.match(html, /批次移除選取/);

  assert.match(api, /if \(action === "admin\.test-mode\.delete-accounts"\)/);
  assert.match(api, /authorizeAdmin\(supabase, identity\)/);
  assert.match(api, /admin_delete_test_accounts/);
  assert.match(api, /new Set\(memberIds\)\.size !== memberIds\.length/);
  assert.match(api, /"test_account_purge"/);
  assert.match(api, /"purged"/);
  assert.match(api, /\{ deletedAccountCount, batch: memberIds\.length > 1 \}/);
  assert.doesNotMatch(api, /\{ memberIds, deletedAccountCount \}/);

  assert.match(migration, /create or replace function public\.admin_delete_test_accounts/);
  assert.match(migration, /is_test_account = true/);
  assert.match(migration, /delete from public\.api_rate_limits/);
  assert.match(migration, /extensions\.digest\(line_user_id, 'sha256'\)/);
  assert.match(migration, /delete from public\.idempotency_results/);
  assert.match(migration, /delete from public\.booking_audit_events/);
  assert.match(migration, /delete from public\.audit_logs/);
  assert.match(migration, /delete from booking_notifications\.outbox/);
  assert.match(migration, /delete from public\.booking_completion_settlements/);
  assert.match(migration, /delete from public\.bookings/);
  assert.match(migration, /delete from public\.point_entries/);
  assert.match(migration, /delete from public\.point_balances/);
  assert.match(migration, /delete from public\.test_login_sessions/);
  assert.match(migration, /delete from public\.service_time_entries/);
  assert.match(migration, /delete from public\.fixed_ticket_grants/);
  assert.ok(
    migration.indexOf('delete from public.service_time_entries') <
      migration.indexOf('delete from public.fixed_ticket_grants'),
    'fixed-ticket grants must be purged after service-time delete triggers finish'
  );
  assert.match(migration, /revoke all on function public\.admin_delete_test_accounts\(uuid\[\]\)/);
  assert.match(migration, /from public, anon, authenticated/);
  assert.match(migration, /to service_role/);
  assert.match(schema, /member_id uuid not null references public\.members\(id\) on delete cascade/);
  assert.match(qaPurge, /before delete on public\.members/);
  assert.match(qaPurge, /automation_test_runs/);
  assert.match(qaPurge, /summary ->> 'source'/);
  assert.match(qaPurge, /automation_test_cases/);
});



test('legacy deleted test-account traces are purged once', () => {
  const migration = read('supabase/migrations/20260920134141_purge_legacy_deleted_test_account_traces.sql');
  assert.match(migration, /actor_line_user_id like 'TEST-%'/);
  assert.match(migration, /not exists \([\s\S]*public\.members/);
  assert.match(migration, /delete from public\.api_rate_limits/);
  assert.match(migration, /delete from public\.idempotency_results/);
  assert.match(migration, /delete from public\.booking_audit_events/);
  assert.match(migration, /delete from public\.audit_logs/);
  assert.match(migration, /test_mode\.accounts\.batch_delete/);
});


test('test-account purge has least-privilege access to booking notification outbox', () => {
  const migration = read('supabase/migrations/20260920134516_grant_test_account_purge_notification_access.sql');
  assert.match(migration, /grant usage on schema booking_notifications to service_role/);
  assert.match(migration, /grant select, delete on table booking_notifications\.outbox to service_role/);
  assert.doesNotMatch(migration, /to anon|to authenticated|to public/);
});


test('test member numbering resets to 1 only after every test account is removed', () => {
  const migration = read('supabase/migrations/20260920134931_reset_test_member_number_after_delete_all.sql');
  assert.match(migration, /pg_advisory_xact_lock\(2026092001\)/);
  assert.match(migration, /select count\(\*\)::integer[\s\S]*where is_test_account = true/);
  assert.match(migration, /if v_remaining_count = 0 then/);
  assert.match(migration, /setval\('public\.test_member_sequence', 1, false\)/);
  assert.match(migration, /nextval\('public\.test_member_sequence'\)/);
});

test('user QA runner is headless and can only be started by the unified admin orchestrator', () => {
  const controller = read('user-test-control.js');
  assert.match(controller, /All visible E2E launchers are centralized in the admin workspace/);
  assert.doesNotMatch(controller, /document\.createElement\('button'\)[\s\S]*user-qa-launcher/);
  assert.doesNotMatch(controller, /data-qa-run="quick"|data-qa-run="full"/);
  assert.doesNotMatch(controller, /runQuick: \(\) => runSuite\('quick'\)/);
  assert.match(controller, /runFull: \(\) => runSuite\('full'\)/);
  assert.match(controller, /stop: \(\) => requestStop\(\)/);
});


test('full user test mode drives real UI flows on every member-facing surface', () => {
  const controller = read('user-test-control.js');
  for (const functionName of [
    'memberHumanProfileEditCase',
    'pointsHumanRedeemCase',
    'eventHumanTicketLifecycleCase',
    'calendarHumanDetailCase',
    'bookingHumanControlsCase',
    'bookingHumanLifecycleCase',
    'bookingHumanGroupLifecycleCase',
    'buttonCoverageCase',
  ]) {
    assert.match(controller, new RegExp('function ' + functionName + '\\('), functionName);
  }
  assert.match(controller, /document\.getElementById\('saveHonorificEditButton'\)\?\.click\(\)/);
  assert.match(controller, /ticket-overview-use/);
  assert.match(controller, /ticketModalAction/);
  assert.match(controller, /data-calendar-date/);
  assert.match(controller, /submitBookingButton/);
  assert.match(controller, /confirmBookingButton/);
  assert.match(controller, /申請取消/);
  assert.match(controller, /bookingPartySize/);
  assert.match(controller, /user\.qa\.browser-run\.record/);
  assert.match(controller, /button\.id !== LAUNCHER_ID/);
  assert.match(controller, /qaInfrastructureControls/);
});

test('human E2E fixtures are test-account-only, ownership checked and cleanup-capable', () => {
  const api = read('supabase/functions/user-test-api/index.ts');
  assert.match(api, /resolveTestSession/);
  assert.match(api, /identity\.isTestAccount !== true/);
  assert.match(api, /user\.qa\.fixture\.prepare/);
  assert.match(api, /user\.qa\.fixture\.cleanup/);
  assert.match(api, /user\.qa\.browser-run\.record/);
  assert.match(api, /QA-UI-PC-/);
  assert.match(api, /QA-UI-TPL-/);
  assert.match(api, /point_card_rewards/);
  assert.match(api, /point_balances/);
  assert.match(api, /QA-UI-EVT-/);
  assert.match(api, /QA-UI-CAL-/);
  assert.match(api, /QA HUMAN E2E/);
  assert.match(api, /QA_FIXTURE_OWNERSHIP_FAILED/);
  assert.match(api, /member_id: identity\.memberId/);
  assert.match(api, /source: "member-client-browser"/);
});

test('real client refresh hooks reuse production render paths instead of synthetic DOM', () => {
  const expected = {
    'points/app.js': /refresh: \(\) => loadCards\(false\)/,
    'event/app.js': /refresh: \(\) => loadOffers\(false\)/,
    'calendar/app.js': /refresh: \(\) => loadCalendar\(\)/,
    'booking/app.js': /refresh: \(\) => refresh\(false\)/,
  };
  for (const [relative, pattern] of Object.entries(expected)) {
    const source = read(relative);
    assert.match(source, /window\.MemberClientQaHooks = Object\.freeze/);
    assert.match(source, pattern, relative);
  }
});


test('user E2E coverage classifies each button attribute independently and survives DOM replacement', () => {
  const controller = read('user-test-control.js');
  assert.match(controller, /function matchesButtonCoverage\(button, pattern\)/);
  assert.match(controller, /candidates\.some\(\(value\) =>/);
  assert.match(controller, /matchesButtonCoverage\(button, pattern\)/);
  assert.doesNotMatch(controller, /pattern\.test\(\[button\.id, button\.className/);
  assert.match(controller, /const findTab = \(cardId\) => Array\.from\(document\.querySelectorAll\('#cardTabs \[data-card-id\]'\)\)/);
  assert.match(controller, /findTab\(targetCardId\)/);
  assert.match(controller, /findTab\(initialCardId\)/);
});

test('calendar E2E invalid-date boundary is backed by semantic ISO date validation', () => {
  const controller = read('user-test-control.js');
  const api = read('supabase/functions/member-calendar-api/index.ts');
  assert.match(controller, /date: '2099-99-99'/);
  assert.match(api, /if \(!parseIsoDate\(date\)\)/);
  assert.doesNotMatch(api, /if \(!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(date\)\)/);
});


test('same-surface test login is blocked by default and can be enabled by an admin toggle', () => {
  const client = read('test-mode-client.js');
  const api = read('supabase/functions/test-mode-api/index.ts');
  const migration = read('supabase/migrations/20260922063942_enhance_e2e_fixture_and_test_surface_sessions_v2.sql');

  assert.match(client, /option\.disabled = unavailable/);
  assert.match(client, /const unavailable = inUse && !allowDuplicateTestLogin/);
  assert.match(client, /activeSurfaces/);
  assert.match(client, /currentSurfaceInUse/);
  assert.match(client, /member-test-account-availability-changed/);
  assert.match(api, /activeSurfaceMap/);
  assert.match(api, /accountsWithAvailability/);
  assert.match(api, /create_test_login_session_v3/);
  assert.match(api, /TEST_SURFACE_ALREADY_ACTIVE/);
  assert.match(api, /p_surface: clientType/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /member_id = p_member_id[\s\S]*surface = p_surface/);
});

test('manual test-data purge immediately revokes user test clients through realtime', () => {
  const client = read('test-mode-client.js');
  const api = read('supabase/functions/test-control-api/index.ts');
  assert.match(api, /test_mode\.data\.purged/);
  assert.match(api, /emitRealtimeEvent/);
  assert.match(client, /eventType === 'test_mode\.data\.purged'/);
  assert.match(client, /clearSession\(\)/);
  assert.match(client, /member-test-session-revoked/);
  assert.match(client, /window\.location\.reload\(\)/);
});
