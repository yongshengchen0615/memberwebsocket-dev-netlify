const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('user full E2E covers non-button feature contracts and new experience controls', () => {
  const source = read('user-test-control.js');

  for (const key of [
    'COMMON_THEME_TOGGLE',
    'COMMON_MEMBERSHIP_MILESTONE',
    'COMMON_FEATURE_CONTRACT_COVERAGE',
    'MEMBER_REFERRAL_BOUNDARY',
    'MEMBER_JOIN_TERMS_FLOW',
    'MEMBER_JOIN_LINE_AUTOMATION_CONTRACT',
    'POINTS_TRANSFER_BOUNDARY',
    'POINTS_HISTORY_DISCLOSURE',
    'EVENT_TODAY_USABLE_LIMIT',
    'EVENT_HISTORY_DISCLOSURE',
    'BOOKING_BENEFITS_RECOMMENDATIONS',
    'BOOKING_BENEFIT_REDEMPTION_LIFECYCLE',
    'BOOKING_RECEIPT_REVIEW_CONTRACT',
    'BOOKING_ACCESSIBLE_SCREENSHOT_RECEIPT',
    'BOOKING_FLOW_STEPPER'
  ]) {
    assert.match(source, new RegExp(key));
  }

  assert.match(source, /themeToggleCase/);
  assert.match(source, /membershipMilestoneCase/);
  assert.match(source, /featureContractCoverageCase/);
  assert.match(source, /memberReferralBoundaryCase/);
  assert.match(source, /memberJoinTermsFlowCase/);
  assert.match(source, /memberJoinLineAutomationContractCase/);
  assert.match(source, /pointsTransferBoundaryCase/);
  assert.match(source, /eventTodayUsableLimitCase/);
  assert.match(source, /bookingBenefitsRecommendationsCase/);
  assert.match(source, /bookingBenefitRedemptionLifecycleCase/);
  assert.match(source, /bookingReceiptReviewContractCase/);
  assert.match(source, /bookingAccessibleScreenshotReceiptCase/);
  assert.match(source, /pointsHistoryDisclosureCase/);
  assert.match(source, /eventHistoryDisclosureCase/);
  assert.match(source, /bookingFlowStepperCase/);
  assert.match(source, /todayButton/);
});

test('admin full E2E covers directory, test-account lifecycle, presets, batch calendar and feature contracts', () => {
  const source = read('admin/e2e-control.js');

  for (const key of [
    'ADMIN_THEME_TOGGLE',
    'ADMIN_MEMBER_DIRECTORY_CONTROLS',
    'ADMIN_MESSAGE_PRESET_EDITOR',
    'ADMIN_CALENDAR_BATCH_CONTROLS',
    'ADMIN_TEST_ACCOUNT_LIFECYCLE',
    'ADMIN_BOOKING_SHARED_SETTINGS',
    'ADMIN_BOOKING_RECEIPT_VIEWER',
    'ADMIN_EVENT_DAILY_LIMIT_SETTINGS',
    'ADMIN_FORCE_LOGOUT_SECURITY',
    'ADMIN_INTEGRATION_CENTER',
    'ADMIN_INTEGRATION_NAVIGATION',
    'ADMIN_FEATURE_CONTRACT_COVERAGE',
    'ADMIN_BUTTON_COVERAGE'
  ]) {
    assert.match(source, new RegExp(key));
  }

  assert.match(source, /systemMaintenanceEnabled/);
  assert.match(source, /testModeSelectAllAccounts/);
  assert.match(source, /deleteSelectedTestAccountsButton/);
  assert.match(source, /data-record-filter/);
  assert.match(source, /admin\.test-mode\.delete-accounts/);
  assert.match(source, /adminBookingSharedSettingsCase/);
  assert.match(source, /adminBookingReceiptViewerCase/);
  assert.match(source, /adminEventDailyLimitSettingsCase/);
  assert.match(source, /adminForceLogoutSecurityCase/);
  assert.match(source, /pairedMemberReferralRewardCase/);
  assert.match(source, /pairedPointTransferAtomicCase/);
  assert.match(source, /pairedForceLogoutRevocationCase/);
  assert.match(source, /PAIRED_MEMBER_REFERRAL_REWARD/);
  assert.match(source, /PAIRED_POINT_TRANSFER_ATOMIC/);
  assert.match(source, /bookingAdminSaveSettingsButton/);
  assert.match(source, /bookingAdminStoreServiceMinutes/);
  assert.match(source, /bookingAdminNotice/);
  assert.match(source, /bookingSharedSettings/);
  assert.match(source, /adminIntegrationCenterCase/);
  assert.match(source, /adminIntegrationNavigationCase/);
  assert.match(source, /integrationMetricGrid/);
  assert.match(source, /integrationNotifications/);
  assert.match(source, /integrationAuditTimeline/);
  assert.match(source, /完成結算預覽/);
  assert.match(source, /stayedConfirmedBeforeSubmit/);
  assert.match(source, /確認完成並結算/);
  assert.match(source, /benefitRedemption/);
  assert.match(source, /pendingAfter/);
  assert.match(source, /待核銷優惠/);
  assert.match(source, /explicitCaseByButtonId/);
  assert.doesNotMatch(source, /waitFor\(async \(\) =>/);
});

test('all member clients and admin load the latest expanded E2E controllers', () => {
  for (const entry of ['member', 'points', 'event', 'calendar', 'booking']) {
    const html = read(entry + '/index.html');
    assert.match(html, /\.\.\/user-test-control\.js\?v=qa-e2e-\d{8}-\d+/);
  }
  const admin = read('admin/index.html');
  assert.match(admin, /\.\/e2e-control\.js\?v=qa-e2e-\d{8}-\d+/);
});
