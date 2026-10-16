const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('full user E2E prepares complex usage state before building cases', () => {
  const runner = read('user-test-control.js');
  const prepareIndex = runner.indexOf("qaServiceRequest('user.qa.usage-state.prepare'");
  const buildIndex = runner.indexOf('buildCases(state.currentSuite)');
  assert.ok(prepareIndex >= 0, 'usage-state prepare action must be called');
  assert.ok(buildIndex > prepareIndex, 'usage-state pack must exist before test cases are built');
  assert.match(runner, /COMMON_USAGE_STATE_COMPLEXITY/);
  assert.match(runner, /usageStateComplexityCase/);
  assert.match(runner, /state\.usageStateError/);
  assert.match(runner, /refreshRealClient\(\)/);
});

test('user QA service exposes state-pack preparation only behind a test session', () => {
  const api = read('supabase/functions/user-test-api/index.ts');
  const resolveIndex = api.indexOf('resolveTestSession');
  const actionIndex = api.indexOf('if (action === "user.qa.usage-state.prepare")');
  assert.match(api, /user\.qa\.usage-state\.prepare/);
  assert.match(api, /prepareUsageState\(s, identity, token, surface\)/);
  assert.ok(resolveIndex >= 0 && actionIndex > resolveIndex);
  assert.match(api, /identity\.isTestAccount !== true/);
  assert.doesNotMatch(api, /SUPABASE_SERVICE_ROLE_KEY[^\n]+window|localStorage|sessionStorage/);
});

test('member state pack includes historical and recent service usage', () => {
  const api = read('supabase/functions/user-test-api/index.ts');
  assert.match(api, /service-history-and-membership-terms/);
  assert.match(api, /historical-service/);
  assert.match(api, /recent-service/);
  assert.match(api, /membership-progress/);
  assert.match(api, /membership-terms-e2e/);
  assert.match(api, /prepare_e2e_membership_terms_fixture/);
  assert.match(api, /service_time_entries/);
});

test('points state pack contains multi-card balances and ticket lifecycle variants', () => {
  const api = read('supabase/functions/user-test-api/index.ts');
  for (const marker of [
    'mixed-point-ticket-lifecycle',
    'multi-card',
    'high-balance',
    'low-balance',
    'available-ticket',
    'used-ticket',
    'expired-ticket',
    'lottery-ticket',
    'date-limited-card',
  ]) assert.match(api, new RegExp(marker));
  assert.match(api, /status: "available"/);
  assert.match(api, /status: "used"/);
  assert.match(api, /status: "expired"/);
  assert.match(api, /ticket_type: "lottery"/);
  assert.match(api, /QA-STATE-PTS-A-/);
  assert.match(api, /QA-STATE-PTS-B-/);
  assert.match(api, /point_entries/);
});

test('event state pack contains claimable claimed used future and past states', () => {
  const api = read('supabase/functions/user-test-api/index.ts');
  for (const marker of ['claimable', 'claimed', 'used', 'future', 'past', 'limited-quota', 'lottery']) {
    assert.match(api, new RegExp(marker));
  }
  assert.match(api, /event_ticket_claims/);
  assert.match(api, /QA-STATE-EVT-CLAIMED-/);
  assert.match(api, /QA-STATE-EVT-USED-/);
  assert.match(api, /QA-STATE-EVT-FUTURE-/);
  assert.match(api, /QA-STATE-EVT-PAST-/);
  assert.match(api, /QA-UI-EVT-LOT-/);
  assert.match(api, /QA 真人操作活動抽獎券/);
  assert.match(api, /lotteryEventTicketId/);
  assert.match(api, /lotteryPrizeCount: 3/);
});

test('calendar state pack covers day types and archived history', () => {
  const api = read('supabase/functions/user-test-api/index.ts');
  for (const marker of ['mixed-calendar-state', 'today', 'holiday', 'multi-day', 'future', 'archived']) {
    assert.match(api, new RegExp(marker));
  }
  assert.match(api, /item_type: "holiday"/);
  assert.match(api, /status: "archived"/);
});

test('booking state pack seeds existing lifecycle before human booking actions', () => {
  const api = read('supabase/functions/user-test-api/index.ts');
  assert.match(api, /mixed-booking-lifecycle/);
  assert.match(api, /\["pending", "cancel_requested"\]/);
  assert.match(api, /action: "user\.booking\.create"/);
  assert.match(api, /action: "user\.booking\.cancel"/);
  assert.match(api, /QA STATE PACK/);
});


test('booking state pack retries slot races and requires both admin lifecycle fixtures', () => {
  const api = read('supabase/functions/user-test-api/index.ts');
  const runner = read('user-test-control.js');
  assert.match(api, /attempt < 8/);
  assert.match(api, /stage: "create"/);
  assert.match(api, /await cleanupBooking\(s, bookingId\)/);
  assert.match(api, /failures: stateFailures\.slice\(-8\)/);
  assert.match(runner, /surface === 'booking' \? 2 : 1/);
  assert.doesNotMatch(runner, /preparedOrSafelySkipped/);
});


test('booking client adaptively retries incomplete state packs until pending and cancel-requested both exist', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /async function prepareUsageStateForFullRun\(\)/);
  assert.match(runner, /const maxAttempts = Math\.max\(3, Math\.min\(7, 2 \+ Number\(state\.complexityLevel/);
  assert.match(runner, /stateKinds\.has\('pending'\) && stateKinds\.has\('cancel_requested'\)/);
  assert.match(runner, /requiredBookingStates = \['pending', 'cancel_requested'\]/);
  assert.match(runner, /usageStateAttempts/);
  assert.match(runner, /state\.usageState = await prepareUsageStateForFullRun\(\)/);
});
