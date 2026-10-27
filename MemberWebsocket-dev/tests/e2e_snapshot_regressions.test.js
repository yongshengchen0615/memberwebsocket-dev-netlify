const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('booking refresh is last-request-wins so stale realtime responses cannot overwrite newer state', () => {
  const app = read('booking/app.js');
  assert.match(app, /refreshSequence: 0/);
  assert.match(app, /const refreshSequence = \+\+state\.refreshSequence/);
  assert.match(app, /if \(refreshSequence !== state\.refreshSequence\) return false/);
  assert.match(app, /較舊的 Bootstrap 回應覆蓋較新的預約狀態/);
});

test('event lottery history renders from the normalized ticket type', () => {
  const app = read('event/app.js');
  assert.match(app, /history && claim && ticket\.ticketType === 'lottery' && claim\.result/);
  assert.match(app, /renderRedeemedResult\(\{ \.\.\.claim, ticketType: 'lottery' \}\)/);
  assert.doesNotMatch(app, /history && claim && claim\.ticketType === 'lottery'/);
});

test('required booking Human E2E searches multiple enabled dates before failing', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /function firstEnabledBookingDate\(offset = 0\)/);
  assert.match(runner, /const maxDateAttempts = Math\.max\(1, Math\.min\(5,/);
  assert.match(runner, /openBookingForSafeDate\(attempt\)/);
  assert.match(runner, /已嘗試多個可預約日期，仍找不到可供真人 E2E 的預約時段/);
});

test('booking edit lifecycle falls back to an available slot when the original slot is not restored', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /let editableSlot = await waitFor/);
  assert.match(runner, /editableSlot = await chooseAvailableSlot\(\)/);
  assert.match(runner, /actual\.editSlotRestored = Boolean\(editableSlot\)/);
});

test('group booking Human E2E searches multiple dates and keeps a safely mutable quantity', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /for \(let attempt = 0; attempt < maxDateAttempts && !slot; attempt \+= 1\)/);
  assert.match(runner, /openBookingForSafeDate\(attempt\)/);
  assert.match(runner, /actual\.firstQuantityTwo = actual\.firstQuantityTwo \|\| Boolean/);
  assert.match(runner, /已嘗試多個可預約日期，仍找不到可容納兩位的安全時段/);
  assert.match(runner, /attemptedDates: maxDateAttempts/);
});

test('required Human E2E coverage reports missing execution without duplicating case failures', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /const missingHumanCases = requiredHumanCases\.filter/);
  assert.match(runner, /const failedHumanCases = requiredHumanCases\.filter/);
  assert.match(runner, /const blockedHumanCases = requiredHumanCases\.filter/);
  assert.match(runner, /Coverage 僅彙總，不重複製造第二個 failure/);
  assert.match(runner, /\.\.\.skip\('真人操作案例已有各自的失敗或環境阻擋結果/);
});

test('admin E2E refreshes stale test roster and waits for member write completion', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /search\.value = memberCode/);
  assert.match(runner, /search\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/);
  assert.match(runner, /await waitFor\(\(\) => !button\.disabled, 10000\)/);
});

test('deep point-card E2E recovers the persisted card id from the rendered admin list', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /#cardListItems \[data-card-id\]/);
  assert.match(runner, /savedCard\?\.dataset\.cardId/);
  assert.match(runner, /await waitAdminWriteSettled\('saveCardButton'\)/);
});

test('admin booking controls and CRUD wait for authoritative panel state between mutations', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /actual\.servicesReady = Boolean\(await waitBookingAdminReady\(15000\)\)/);
  assert.match(runner, /bookingAdminTypeList'\)\?\.children\.length > 0/);
  assert.match(runner, /if \(actual\.typeCreated\) \{ await waitBookingAdminReady\(15000\); await wait\(120\); \}/);
  assert.match(runner, /if \(actual\.serviceUpdated\) \{ await waitBookingAdminReady\(15000\); await wait\(120\); \}/);
});


test('admin E2E delay helper is defined for CRUD and deep realtime call sites', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /function wait\(ms\) \{\s*return sleep\(ms\);\s*\}/);
});

test('event lottery history waits for asynchronous result rendering', () => {
  const runner = read('user-test-control.js');
  assert.match(
    runner,
    /lotteryHistoryResultVisible = Boolean\(await waitFor\(\(\) => \{[\s\S]*#ticketModalResult \.lottery-result strong[\s\S]*actual\.lotteryPrizeTitle[\s\S]*\}, 4000, 100\)\)/
  );
});

test('booking admin refreshes coalesce instead of dropping updates', () => {
  const core = read('admin/booking-panel-core.js');
  const cancellation = read('admin/booking-cancellation-sync.js');
  assert.match(core, /state\.refreshQueued = true/);
  assert.match(core, /window\.setTimeout\(\(\) => \{ refreshAll\(queuedShowSuccess\); \}, 0\)/);
  assert.match(cancellation, /refreshQueuedIncludeBookings = refreshQueuedIncludeBookings \|\| Boolean\(includeBookings\)/);
  assert.match(cancellation, /document\.visibilityState === 'hidden' && !isBackgroundE2ERunner\(\)/);
});

test('booking admin actions do not cascade one item-mutation failure into technician and completion failures', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /caseDef\(prefix \+ 'MODIFY_TECHNICIAN'[\s\S]*if \(!actual\.confirmed\?\.ok\)/);
  assert.doesNotMatch(runner, /caseDef\(prefix \+ 'MODIFY_TECHNICIAN'[\s\S]{0,500}!actual\.modified\?\.ok/);
  assert.match(runner, /caseDef\(prefix \+ 'COMPLETE'[\s\S]*if \(!actual\.confirmed\?\.ok\)/);
  assert.match(runner, /expectedRealtimeChecks/);
  assert.match(runner, /realtimeRows\.length >= expectedRealtimeChecks/);
});

test('group booking item mutation has a non-expanding fallback for assigned technicians', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /mutationMode = 'remove-item'/);
  assert.match(runner, /safeMutation: removingItem\s*\? 'remove-existing-item'/);
  assert.match(runner, /const afterQuantity = removingItem \? 0/);
});

test('dynamic test-history buttons expose stable metadata for coverage classification', () => {
  const client = read('admin/test-control.js');
  assert.match(client, /button\.dataset\.testRunId\s*=\s*String\(run\.id\s*\|\|\s*''\)/);
});


test('tutorial journey keeps the skipped-result helper callable', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /const skipButton = document\.getElementById\('memberTourSkip'\)/);
  assert.doesNotMatch(runner, /const skip = document\.getElementById\('memberTourSkip'\)/);
  assert.doesNotMatch(runner, /if \(pairedRunner && state\.participantIndex > 1\)/);
});

test('paired runner reuses a valid same-run surface session instead of creating a conflicting login', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /function reusablePairedSession\(participant, surface\)/);
  assert.match(runner, /expiresAt <= Date\.now\(\) \+ 30000/);
  assert.match(runner, /const login = reusablePairedSession\(participant, surface\) \|\|[\s\S]*?createPairedSession\(participant\.account, surface\)/);
  assert.match(runner, /const bookingLogin = reusablePairedSession\(participant, 'booking'\) \|\|[\s\S]*?createPairedSession\(participant\.account, 'booking'\)/);
});

test('paired booking admin mutations wait for the completed user handoff', () => {
  const runner = read('admin/e2e-control.js');
  assert.doesNotMatch(runner, /const liveAdminTasks = selectedModules\.includes\('booking'\)/);
  assert.match(runner, /pairedAdminBookingChain = Promise\.resolve\(\)/);
  assert.match(
    runner,
    /if \(surface === 'booking'\) \{[\s\S]*?participant\.bookingResult = child;[\s\S]*?runPairedAdminBookingLive\(participant\)[\s\S]*?await participant\.adminBookingTask;/
  );
  assert.match(runner, /await clientExecution;/);
});

test('admin E2E API failures retain bounded transport context', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /functionSlug: String\(slug \|\| ''\)\.slice\(0, 80\)/);
  assert.match(runner, /action = String\(body\?\.action \|\| ''\)\.slice\(0, 120\)/);
  assert.match(runner, /timeout\.apiDiagnostic = diagnostic\('timeout', \{ aborted: true \}\)/);
  assert.match(runner, /transport\.apiDiagnostic = diagnostic\('transport'\)/);
  assert.match(runner, /httpStatus: Number\(response\.status \|\| 0\)/);
  assert.match(runner, /\.\.\.\(api \? \{ api \} : \{\}\)/);
});

test('all affected entrypoints bust caches for the fixed controllers', () => {
  for (const surface of ['member','points','event','calendar','booking']) {
    assert.match(read(surface + '/index.html'), /user-test-control\.js\?v=qa-e2e-\d{8}-\d+/);
  }
  assert.match(read('booking/index.html'), /app\.js\?v=booking-member-chat-20261003-1/);
  assert.match(read('event/index.html'), /app\.js\?v=[^" ]+/);
  assert.doesNotMatch(read('admin/index.html'), /test-control\.js\?v=test-control-[A-Za-z0-9._-]+/);
  assert.doesNotMatch(read('admin/index.html'), /e2e-control\.js\?v=qa-e2e-\d{8}-\d+/);
  assert.match(read('admin/e2e-control-loader.js'), /const E2E_CONTROL_SRC/);
});


test('missing membership terms are an environment skip instead of a duplicated E2E regression', () => {
  const api = read('supabase/functions/test-control-api/index.ts');
  const admin = read('admin/test-control.js');

  assert.match(api, /function skip\(code: string/);
  assert.match(api, /: skip\([\s\S]*?"MEMBERSHIP_TERMS_NOT_CONFIGURED"/);
  assert.match(api, /const caseStatus = result\.skipped \? "skipped" : result\.passed \? "passed" : "failed"/);
  assert.match(api, /skipped: rows\.filter\(\(row: any\) => row\.status === "skipped"\)\.length/);
  assert.match(api, /completedCases: counters\.passed \+ counters\.failed \+ counters\.skipped/);
  assert.match(api, /skippedCases: counters\.skipped/);

  assert.match(api, /termsConfigured: applicable\.some/);
  assert.match(api, /skipCode: "MEMBERSHIP_RECONSENT_NOT_REQUIRED"/);
  assert.match(api, /currentConsentCount: memberIds\.length/);
  assert.doesNotMatch(
    api,
    /if \(!activeTerms\?\.id\) throw new ApiError\(409, "MEMBERSHIP_TERMS_NOT_CONFIGURED"/
  );

  assert.match(admin, /passed \+ failed \+ skipped/);
  assert.match(admin, /個環境條件未配置而略過/);
});


test('browser run artifact metrics count persisted screenshots instead of failed cases', () => {
  const api = read('supabase/functions/test-control-api/index.ts');
  const runner = read('admin/e2e-control.js');

  assert.match(api, /failureArtifactCases = normalized\.filter/);
  assert.match(api, /screenshot\?\.path/);
  assert.match(api, /failureDiagnosticCases: failed/);
  assert.match(api, /failureScreenshotCases: failureArtifactCases/);
  assert.doesNotMatch(api, /failureArtifactCases: failed/);

  assert.match(runner, /const fatalFailure = \{/);
  assert.match(runner, /await attachFailureScreenshot\(fatalFailure, window\)/);
});


test('skipped backend cases keep selected-scope verification incomplete', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /const completedCases = Number\(run\.passedCases \|\| 0\);/);
  assert.match(runner, /failedCases === 0 && skippedCases === 0/);
  assert.match(runner, /run\.summary\?\.coverageComplete !== false/);
});

test('event daily-limit E2E waits for the current server snapshot to reach the badge', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /const badge = await waitFor\(\(\) => \{[\s\S]*?node.textContent === expectedText[\s\S]*?Number\(node.dataset.maxTicketsPerDay\) === limit/);
  assert.match(runner, /6000, 100\)/);
  assert.doesNotMatch(runner, /const badge = await waitFor\(\(\) => document\.getElementById\('todayUsableTicketCount'\), 3000\)/);
});

test('booking receipt E2E follows the booking-scoped receipt list contract', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /const bookings = Array\.isArray\(data\?\.bookings\) \? data\.bookings : \[\]/);
  assert.match(runner, /const receipts = bookings\.map\(\(booking\) => booking\?\.receipt\)\.filter\(Boolean\)/);
  assert.match(runner, /bookingsArray: Array\.isArray\(data\?\.bookings\)/);
  assert.doesNotMatch(runner, /receiptsArray: Array\.isArray\(data\?\.receipts\)/);
});

test('referral E2E owns and cleans only its QA referral reward fixture', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /ticketType: 'referral'/);
  assert.match(runner, /qaRewardEventTicketId = String\(rewardFixture\?\.eventTicket\?\.eventTicketId \|\| ''\)/);
  // Issuance creates a child event; ownership and replay behavior are tested in e2e_referral_current_rule.test.js.
  assert.match(runner, /offer\.ticket\?\.title === 'E2E 好友邀請獎勵 ' \+ stamp/);
  assert.match(runner, /eventTicketId: qaRewardEventTicketId/);
  assert.doesNotMatch(runner, /generatedRewardEventTicketId = rewardEventTicketId/);
});

test('last-ticket race verifies both browser states in parallel with bounded waits', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /ui = await Promise\.all\(candidates\.map\(async \(participant, index\) => \{/);
  assert.match(runner, /waitParticipantSurface\(participant, 'event', 'eventView', 12000\)/);
  assert.match(runner, /backgroundAwareTimeout\(6000, 12000\)/);
});

test('booking participant item migration qualifies formerly ambiguous RPC columns', () => {
  const migration = read('supabase/migrations/20261001131704_fix_booking_participant_items_ambiguous_columns.sql');
  assert.match(migration, /bi_store\.booking_id = b\.id/);
  assert.match(migration, /bpi_delete\.participant_id = participant\.id/);
  assert.match(migration, /bi_delete\.booking_id = b\.id/);
  assert.match(migration, /where bk\.id = b\.id/);
});


test('paired participant navigation waits for the newly loaded controller instead of a stale same-surface page', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /participant\.lastNavigationKey = navigationKey/);
  assert.match(runner, /currentUrl\.searchParams\.get\('qaPair'\)/);
  assert.match(runner, /child\.document\?\.readyState !== 'complete'/);
  assert.match(runner, /expectedNavigationKey/);
});


test('test-data purge removes transfer and referral dependencies before test members', () => {
  const migration = read('supabase/migrations/20261001134258_purge_test_growth_transfer_dependencies.sql');
  const purgeStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.admin_purge_test_data');
  const deleteAccountsStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.admin_delete_test_accounts');
  assert.ok(purgeStart >= 0);
  assert.ok(deleteAccountsStart >= 0);

  const purge = migration.slice(purgeStart);
  assert.match(purge, /delete from public\.member_referrals[\s\S]*?inviter_member_id = any\(v_test_member_ids\)[\s\S]*?invitee_member_id = any\(v_test_member_ids\)/i);
  assert.match(purge, /delete from public\.point_transfers[\s\S]*?sender_member_id = any\(v_test_member_ids\)[\s\S]*?receiver_member_id = any\(v_test_member_ids\)/i);
  assert.match(purge, /deletedPointTransfers/i);
  assert.match(purge, /deletedMemberReferrals/i);
  assert.match(purge, /not exists \(select 1 from public\.point_transfers t where t\.point_card_id = pc\.id\)/i);
  assert.match(purge, /not exists \(select 1 from public\.member_referrals r where r\.reward_event_ticket_id = e\.id\)/i);
  assert.match(purge, /TEST_DATA_CROSS_BOUNDARY_POINT_TRANSFER/);
  assert.match(purge, /TEST_DATA_CROSS_BOUNDARY_REFERRAL/);

  const deleteAccounts = migration.slice(deleteAccountsStart);
  assert.match(deleteAccounts, /delete from public\.member_referrals[\s\S]*?inviter_member_id = any\(p_member_ids\)[\s\S]*?invitee_member_id = any\(p_member_ids\)/i);
  assert.match(deleteAccounts, /delete from public\.point_transfers[\s\S]*?sender_member_id = any\(p_member_ids\)[\s\S]*?receiver_member_id = any\(p_member_ids\)/i);
  assert.match(deleteAccounts, /TEST_DATA_CROSS_BOUNDARY_POINT_TRANSFER/);
  assert.match(deleteAccounts, /TEST_DATA_CROSS_BOUNDARY_REFERRAL/);
});
