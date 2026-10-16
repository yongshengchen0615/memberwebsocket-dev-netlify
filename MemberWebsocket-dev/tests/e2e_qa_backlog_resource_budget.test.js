const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('QA backlog has browser E2E contracts for legal, booking reminder and overnight settings', () => {
  const admin = read('admin/e2e-control.js');
  const user = read('user-test-control.js');

  assert.match(admin, /ADMIN_MEMBERSHIP_TERMS/);
  assert.match(admin, /adminMembershipTermsCase/);
  assert.match(user, /MEMBER_TERMS_CONSENT/);
  assert.match(user, /TERMS_CONSENT_REQUIRED/);
  assert.match(user, /TERMS_VERSION_STALE/);
  assert.match(user, /MEMBERSHIP_TERMS_NOT_CONFIGURED/);
  assert.match(user, /會員條款尚未由管理端啟用/);

  assert.match(admin, /bookingAdminReminderEnabled/);
  assert.match(admin, /bookingAdminReminderTime/);
  assert.match(admin, /invalidReminderRejected/);
  assert.match(admin, /reminderSettingsSaved/);
  assert.match(admin, /\['14:00', '02:00'\]/);
  assert.match(admin, /overnightSettingsSaved/);
});

test('activity coupon E2E covers temporal boundaries and last-ticket race', () => {
  const admin = read('admin/e2e-control.js');
  const user = read('user-test-control.js');

  assert.match(user, /EVENT_BOUNDARY_STATES/);
  assert.match(user, /EVENT_NOT_STARTED/);
  assert.match(user, /EVENT_ENDED/);
  assert.match(admin, /PAIRED_EVENT_LAST_TICKET_RACE/);
  assert.match(admin, /quota: 1/);
  assert.match(admin, /EVENT_QUOTA_REACHED/);
  assert.match(admin, /Promise\.allSettled/);
});

test('tour E2E remains explicit across all user surfaces', () => {
  const user = read('user-test-control.js');
  assert.match(user, /COMMON_TOUR_AUTOSTART/);
  assert.match(user, /COMMON_TOUR_JOURNEY/);
  assert.match(user, /tourAutoStartCase/);
  assert.match(user, /tourJourneyCase/);
});

test('all user surfaces load the same QA E2E runner cache version', () => {
  for (const surface of ['member','points','event','calendar','booking']) {
    const html = read(surface + '/index.html');
    assert.match(html, /user-test-control\.js\?v=qa-e2e-\d{8}-\d+/);
  }
});


test('paired E2E tutorial cannot block the remaining suite', () => {
  const user = read('user-test-control.js');

  assert.match(user, /async function dismissTourForE2E/);
  assert.doesNotMatch(user, /if \(pairedRunner && state\.participantIndex > 1\)/);
  assert.match(user, /A broken tutorial must fail its own case, not lock the rest of the E2E run behind app\.inert/);
  assert.match(user, /app\.inert = false/);
  assert.match(user, /forcedCleanup/);
});
