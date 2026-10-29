const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('admin full E2E mutates booking shared settings, verifies cross-end behavior, conflicts and preserves the final mutation', () => {
  const source = read('admin/e2e-control.js');

  assert.match(source, /ADMIN_BOOKING_SHARED_SETTINGS/);
  assert.match(source, /adminBookingSharedSettingsCase/);
  assert.match(source, /if \(normalizedDomain === 'Admin Settings E2E'\) return true;/);
  assert.match(source, /const preflightKeys = new Set\(\['ADMIN_AUTH_READY'\]\)/);
  assert.match(source, /if \(selectedModules\.includes\('booking'\)\) \{\s*preflightKeys\.add\('ADMIN_BOOKING_CONTROLS'\);\s*preflightKeys\.add\('ADMIN_BOOKING_SHARED_SETTINGS'\)/);
  assert.match(source, /remainingAdminDefinitions = allAdminDefinitions\.filter\(\(def\) => !preflightKeys\.has\(def\.key\)\)/);
  for (const id of [
    'bookingAdminSettingsForm',
    'bookingAdminStartTime',
    'bookingAdminEndTime',
    'bookingAdminAdvanceDays',
    'bookingAdminMaxAdvanceDays',
    'bookingAdminStoreServiceMinutes',
    'bookingAdminNotice',
    'bookingAdminSaveSettingsButton'
  ]) {
    assert.match(source, new RegExp(id));
  }

  assert.match(source, /admin\.booking\.manage\.bootstrap/);
  assert.match(source, /admin\.booking\.settings\.save/);
  assert.match(source, /user\.booking\.bootstrap/);
  assert.match(source, /user\.booking\.group\.slots/);
  assert.match(source, /booking-group-slots-api/);
  assert.match(source, /invalidWorkHoursRejected/);
  assert.match(source, /invalidAdvanceRejected/);
  assert.match(source, /invalidStoreMinutesRejected/);
  assert.match(source, /invalidNoticeRejected/);
  assert.match(source, /validMutationSaved/);
  assert.match(source, /mutatedReadback/);
  assert.match(source, /updatedAtChanged/);
  assert.match(source, /staleVersionRejected/);
  assert.match(source, /BOOKING_SETTINGS_CONFLICT/);
  assert.match(source, /userRealtimeSettingsSynced/);
  assert.match(source, /userRealtimeNoticeSynced/);
  assert.match(source, /userBootstrapMatched/);
  assert.match(source, /userStoreMinutesMatched/);
  assert.match(source, /userDateWindowEnforced/);
  assert.match(source, /finalMutationReadback/);
  assert.match(source, /mutationRetainedForInspection/);
  assert.match(source, /retainedSettings/);
  assert.match(source, /retainedBaseNotice/);
  assert.match(source, /QA E2E SHARED/);
  assert.doesNotMatch(source, /restoreFallbackUsed/);
  assert.doesNotMatch(source, /actual\.restoredViaUi/);
  assert.doesNotMatch(source, /actual\.restoreReadback/);
  assert.doesNotMatch(source, /actual\.userRestoreSynced/);
  assert.match(source, /admin\.test-control\.prepare-test-account-consents/);
  assert.match(source, /E2E_TEST_MEMBER_CONSENT_NOT_READY/);
  assert.match(source, /currentConsentCount/);
  assert.match(source, /createPairedSession/);
  assert.match(source, /surfaceLogins/);
  assert.match(source, /reusablePairedSession\(participant, 'booking'\)/);
  assert.match(source, /waitParticipantSurface/);
  assert.match(source, /expectedUpdatedAt/);
  assert.doesNotMatch(source, /semanticValuesUnchanged/);
});

test('booking shared-settings controls are explicit feature and button coverage contracts', () => {
  const source = read('admin/e2e-control.js');

  assert.match(source, /bookingSharedSettings/);
  assert.match(source, /bookingWorkingHours/);
  assert.match(source, /bookingAdvanceMinimum/);
  assert.match(source, /bookingAdvanceMaximum/);
  assert.match(source, /bookingStoreServiceMinutes/);
  assert.match(source, /bookingNotice/);
  assert.match(source, /explicitCaseByButtonId/);
  assert.match(source, /\['bookingAdminSaveSettingsButton', 'ADMIN_BOOKING_SHARED_SETTINGS'\]/);
  assert.match(source, /registeredCaseKeys/);
});

test('booking admin refresh merges the richer admin settings contract', () => {
  const source = read('admin/booking-panel-core.js');
  assert.match(source, /settings:\s*\{\s*\.\.\.\(booking\.settings \|\| \{\}\),\s*\.\.\.\(catalog\.settings \|\| \{\}\),\s*\.\.\.\(resources\.settings \|\| \{\}\)\s*\}/);
});

test('admin entrypoint does not expose the shared-settings E2E controller', () => {
  const html = read('admin/index.html');
  assert.doesNotMatch(html, /\.\/e2e-control\.js\?v=qa-e2e-\d{8}-\d+/);
  assert.match(read('admin/e2e-control-loader.js'), /const E2E_CONTROL_SRC/);
});


test('ticket service requirements replace the global booking switch in both management views', () => {
  const html = read('admin/index.html');
  const core = read('admin/booking-panel-core.js');
  const loader = read('admin/booking-panel.js');
  assert.equal((html.match(/票券使用與預約/g) || []).length, 2);
  assert.match(html, /指定適用服務項目的票券，使用前須有已確認、未完成且符合項目的預約/);
  assert.doesNotMatch(html, /data-open-ticket-booking-policy/);
  assert.doesNotMatch(core, /bookingAdminTicketBookingRequired|bookingAdminTicketPolicyHeading/);
  assert.doesNotMatch(core, /handleTicketBookingPolicyNavigation|ticketBookingRequired:/);
  assert.match(core, /snapshotLocationRequired: els\.bookingAdminSnapshotLocationRequired\.checked/);
  assert.match(loader, /booking-panel-core\.js', '.*service-ticket-rule-20261015-1-booking-risk-20261021-1-risk-tab-20261023-1-risk-ux-20261023-2-layout-20261028-1-phone-slots-20261029-2'/);
  assert.match(html, /booking-panel\.js\?v=[^"']*service-ticket-rule-20261015-1/);
});
