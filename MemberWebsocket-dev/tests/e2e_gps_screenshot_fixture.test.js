const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const user = readFileSync(join(root, 'user-test-control.js'), 'utf8');
const server = readFileSync(join(root, 'supabase/functions/user-test-api/index.ts'), 'utf8');
const receipts = readFileSync(join(root, 'booking/booking-receipt.js'), 'utf8');

function gpsHarness(getCurrentPosition, isSecureContext = true) {
  const from = user.indexOf('  async function captureE2EGpsFixture() {');
  const to = user.indexOf('  function gpsFixtureCase() {', from);
  assert.ok(from > 0 && to > from, 'GPS capture implementation remains available');
  return vm.runInNewContext(user.slice(from, to) + '\n captureE2EGpsFixture;', {
    navigator: { geolocation: { getCurrentPosition } },
    window: { isSecureContext }, Date, Number, Promise, Math
  });
}

test('GPS acquisition produces a fresh precise test-only record before E2E steps', async () => {
  let requested;
  const capture = gpsHarness((success, failure, options) => {
    requested = options;
    success({ coords: { latitude: 25.03396421, longitude: 121.56446782, accuracy: 12 }, timestamp: Date.now() });
  });
  const gps = await capture();
  assert.deepEqual(gps.status, 'ready');
  assert.equal(gps.source, 'browser-geolocation');
  assert.equal(gps.testOnly, true);
  assert.equal(gps.latitude, 25.033964);
  assert.equal(gps.longitude, 121.564468);
  assert.equal(gps.accuracyMeters, 12);
  assert.equal(requested.maximumAge, 0);
  assert.equal(requested.enableHighAccuracy, true);
  assert.equal(Date.parse(gps.expiresAt) - Date.parse(gps.capturedAt), 120000);
});

test('GPS denial, timeout and stale location cannot become a valid fixture', async () => {
  const denied = await gpsHarness((resolve, reject) => reject({code:1}))();
  assert.equal(denied.status, 'denied');
  assert.ok(!('latitude' in denied));
  const timeout = await gpsHarness((resolve, reject) => reject({code:3}))();
  assert.equal(timeout.status, 'timeout');
  const stale = await gpsHarness(resolve => resolve({
    coords:{latitude:25,longitude:121,accuracy:8},timestamp:Date.now()-180000
  }))();
  assert.equal(stale.status, 'invalid');
  const imprecise = await gpsHarness(resolve => resolve({
    coords:{latitude:25,longitude:121,accuracy:180},timestamp:Date.now()
  }))();
  assert.equal(imprecise.status, 'imprecise');
  assert.equal((await gpsHarness(()=>{}, false)()).status, 'unavailable');
});

test('GPS is recorded only within test-run summary and cannot override business GPS authorization', () => {
  assert.match(user, /state\.gpsFixture = await captureE2EGpsFixture\(\)/);
  assert.match(user, /gpsTestFixture: state\.gpsFixture/);
  assert.match(server, /gpsTestFixture = normalizeE2EGpsFixture\(timing\.gpsTestFixture, startedAt, completedAt\)/);
  assert.match(server, /gpsTestFixture,/);
  assert.match(server, /gpsIncomplete \|\|/);
  assert.match(server, /Never use it for eligibility/);
  assert.match(receipts, /return requestSnapshotGps\(policy\)/);
  assert.match(receipts, /testSessionToken/);
});

test('QA booking snapshot uses actual sanitized screenshot and checks persisted receipt', () => {
  assert.match(user, /const captureE2ESnapshotBlob = captureFailureScreenshotBlob/);
  assert.match(user, /const captured = await captureE2ESnapshotBlob\(\)/);
  assert.match(user, /actual\.screenshotSource = 'screen-capture'/);
  assert.match(user, /openAccessibleE2ESnapshot\(captured\.blob\)/);
  assert.match(user, /actual\.awaitingReview = Boolean\(created\)/);
  assert.match(receipts, /acceptFile\(file\)/);
  assert.match(receipts, /if \(!await authorizeSnapshot\(false\)\)/);
});
