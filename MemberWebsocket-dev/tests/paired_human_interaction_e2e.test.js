const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('all five user surfaces load the human-evidence E2E runner asset', () => {
  for (const surface of ['member', 'points', 'event', 'calendar', 'booking']) {
    const html = read(surface + '/index.html');
    assert.match(html, /e2e-scenario-graph\.js\?v=e2e-graph-20261004-\d+/);
    assert.match(html, /user-test-control\.js\?v=qa-e2e-\d{8}-\d+/);
  }
});

test('user full E2E requires observable UI events for Human E2E cases', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /const VERSION = '2026-10-\d{2}\.\d+'/);
  assert.match(runner, /captureHumanInteraction/);
  assert.match(runner, /\['click', 'input', 'change', 'submit'\]/);
  assert.match(runner, /humanRequired: domain === 'Human E2E'/);
  assert.match(runner, /humanInteractionEventsAtLeast: 1/);
  assert.match(runner, /COMMON_TOUR_AUTOSTART/);
  assert.match(runner, /測試帳號自動教學啟動/);
  assert.match(runner, /missingEvidenceKeys/);
  assert.match(runner, /MEMBER_HUMAN_PROFILE_EDIT/);
  assert.match(runner, /POINTS_HUMAN_REDEEM/);
  assert.match(runner, /EVENT_HUMAN_LIFECYCLE/);
  assert.match(runner, /lotteryEventTicketId/);
  assert.match(runner, /lotteryResultVisible/);
  assert.match(runner, /lotteryHistoryResultVisible/);
  assert.match(runner, /#ticketModalResult \.lottery-result strong/);
  assert.match(runner, /CALENDAR_HUMAN_DETAIL/);
  assert.match(runner, /BOOKING_HUMAN_LIFECYCLE/);
  assert.match(runner, /BOOKING_BENEFIT_REDEMPTION_LIFECYCLE/);
  assert.match(runner, /BOOKING_HUMAN_GROUP/);
  assert.doesNotMatch(runner, /data-qa-run="quick"|data-qa-run="full"/);
  assert.doesNotMatch(runner, /runQuick: \(\) => runSuite\('quick'\)/);
});

test('admin paired full E2E requires human UI evidence and covers every client surface', () => {
  const html = read('admin/index.html');
  const runner = read('admin/e2e-control.js');
  assert.match(html, /e2e-control\.js\?v=qa-e2e-\d{8}-\d+/);
  assert.match(runner, /const VERSION = '2026-10-\d{2}\.\d+'/);
  assert.match(runner, /captureAdminHumanInteraction/);
  assert.match(runner, /adminHumanRequired/);
  assert.match(runner, /humanInteractionEventsAtLeast: 1/);
  assert.match(runner, /humanInteractionVerified/);
  assert.match(runner, /PAIRED_HUMAN_INTERACTION_COVERAGE/);
  assert.match(runner, /if \(!state\.cancelled\) \{/);
  assert.doesNotMatch(runner, /bookingOnly|includeAdminSuite/);
  assert.match(runner, /benefitRedemption/);
  assert.match(runner, /pendingAfter/);
  for (const surface of ['member', 'points', 'event', 'calendar', 'booking']) {
    assert.match(runner, new RegExp("\\['" + surface + "',"));
  }
});

test('coverage assertion is observational and does not recursively require its own UI event', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(
    runner,
    /normalizedKey === 'PAIRED_HUMAN_INTERACTION_COVERAGE' \|\| normalizedDomain === 'Coverage'/
  );
});

test('fixture and assertion APIs remain separate from the human UI gate', () => {
  const user = read('user-test-control.js');
  const admin = read('admin/e2e-control.js');
  assert.match(user, /user\.qa\.usage-state\.prepare/);
  assert.match(user, /recordBrowserRun/);
  assert.match(admin, /prepareComplexE2EFixtures/);
  assert.match(admin, /recordResultRows/);
  assert.match(admin, /pairedHumanInteractionCoverageCase/);
});


test('admin booking lifecycle has fixed evidence keys and accessible review settlement coverage', () => {
  const runner = read('admin/e2e-control.js');
  const accessible = read('admin/booking-accessible-admin.js');
  const coverage = read('e2e-feature-coverage.js');

  for (const key of [
    'ADMIN_BOOKING_REJECT',
    'ADMIN_BOOKING_CONFIRM',
    'ADMIN_BOOKING_MODIFY_ITEMS',
    'ADMIN_BOOKING_MODIFY_TECHNICIAN',
    'ADMIN_BOOKING_COMPLETE',
    'ADMIN_BOOKING_CANCELLATION_KEEP',
    'ADMIN_BOOKING_CANCELLATION_APPROVE',
    'ADMIN_BOOKING_TERMINAL_STATE',
    'ADMIN_BOOKING_REALTIME_SYNC',
    'ADMIN_BOOKING_RISK_SCAN',
    'ADMIN_BOOKING_ACCESSIBLE_REVIEW',
    'ADMIN_BOOKING_ACCESSIBLE_IDEMPOTENCY'
  ]) {
    assert.match(runner, new RegExp(key));
  }

  assert.match(runner, /adminBookingPairedOperationEvidenceCase/);
  assert.match(runner, /adminBookingAccessibleReviewCase/);
  assert.match(runner, /adminBookingAccessibleIdempotencyCase/);
  assert.match(runner, /user\.qa\.fixture\.prepare/);
  assert.match(runner, /admin\.booking\.receipt\.register/);
  assert.match(runner, /alreadyApplied/);
  assert.match(runner, /rewardPointsAtLeast:1/);
  assert.match(runner, /ticketRedeemed:true/);

  assert.match(accessible, /card\.dataset\.receiptId/);
  assert.match(accessible, /card\.dataset\.reviewStatus/);
  assert.match(accessible, /modal\.dataset\.receiptId/);

  assert.match(coverage, /booking\.admin-lifecycle/);
  assert.match(coverage, /ADMIN_BOOKING_CONFIRM/);
  assert.match(coverage, /ADMIN_BOOKING_ACCESSIBLE_REVIEW/);
  assert.match(coverage, /ADMIN_BOOKING_ACCESSIBLE_IDEMPOTENCY/);
});
