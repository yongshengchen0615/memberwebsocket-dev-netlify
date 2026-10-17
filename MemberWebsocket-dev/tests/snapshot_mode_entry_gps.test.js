const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..');
const read = relative => readFileSync(join(root, relative), 'utf8');

function setup({ required = false, onPosition = () => {}, onPolicy } = {}) {
  const events = [];
  let gpsCalls = 0;
  let policyCalls = 0;
  const window = {
    isSecureContext: true,
    BookingSystem: {
      getSession: () => ({ idToken: 'fixture', config: {} }),
      request: async () => {
        policyCalls += 1;
        if (onPolicy) return onPolicy();
        return { snapshotLocationRequired: required, snapshotLocations: required
          ? [{ name: '指定門市', latitude: 25.03, longitude: 121.56, radiusMeters: 100 }] : [] };
      }
    },
    addEventListener() {},
    dispatchEvent(event) { events.push(event.detail); }
  };
  const document = { addEventListener() {} };
  const navigator = { geolocation: { getCurrentPosition(success, failure, options) {
    gpsCalls += 1;
    assert.ok(policyCalls > 0, 'Admin policy must be read before GPS permission');
    onPosition(success, failure, options);
  } } };
  class CustomEvent { constructor(name, options) { this.type = name; this.detail = options.detail; } }
  vm.runInNewContext(read('booking/booking-receipt.js'),
    { window, document, navigator, CustomEvent, console });
  return { api: window.BookingReceipts, events, gpsCalls: () => gpsCalls, policyCalls: () => policyCalls };
}

test('admin GPS OFF skips geolocation and permits snapshot capture', async () => {
  const fixture = setup({ onPosition: () => assert.fail('GPS must not be requested') });
  assert.equal(await fixture.api.beginSnapshotMode(), null);
  assert.equal(fixture.gpsCalls(), 0);
  assert.equal(fixture.policyCalls(), 1);
  assert.deepEqual(fixture.events.map(event => event.status), ['checking', 'optional']);
  fixture.api.endSnapshotMode();
  assert.equal(fixture.events.at(-1).status, 'idle');
});

test('admin GPS ON requests accurate GPS only after the policy is known', async () => {
  const fixture = setup({ required: true, onPosition(success, _fail, options) {
    assert.equal(options.maximumAge, 0);
    assert.equal(options.enableHighAccuracy, true);
    success({ coords: { latitude: 25.03, longitude: 121.56, accuracy: 16 }, timestamp: Date.now() });
  } });
  const fix = await fixture.api.beginSnapshotMode();
  assert.equal(fix.latitude, 25.03);
  assert.equal(fixture.gpsCalls(), 1);
  assert.equal(fixture.policyCalls(), 1);
  assert.deepEqual(fixture.events.map(event => event.status), ['checking', 'requesting', 'ready']);
});

test('GPS rejection is shown only when admin GPS ON and retry recovers', async () => {
  let deny = true;
  const fixture = setup({ required: true, onPosition(success, fail) {
    if (deny) fail({ code: 1 });
    else success({ coords: { latitude: 25.03, longitude: 121.56, accuracy: 20 }, timestamp: Date.now() });
  } });
  await assert.rejects(fixture.api.beginSnapshotMode(), /定位權限未開啟/);
  assert.equal(fixture.events.at(-1).status, 'error');
  deny = false;
  await fixture.api.beginSnapshotMode();
  assert.equal(fixture.events.at(-1).status, 'ready');
  assert.equal(fixture.gpsCalls(), 2);
});

test('iOS CoreLocation temporarily unavailable retries once with a real, validated fix', async () => {
  const modes = [];
  const fixture = setup({ required: true, onPosition(success, fail, options) {
    modes.push(options.enableHighAccuracy);
    if (modes.length === 1) fail({ code: 2 });
    else success({ coords: { latitude: 25.03, longitude: 121.56, accuracy: 18 }, timestamp: Date.now() });
  } });
  const fix = await fixture.api.beginSnapshotMode();
  assert.equal(fix.accuracy, 18);
  assert.deepEqual(modes, [true, false]);
  assert.equal(fixture.events.at(-1).status, 'ready');
});

test('unavailable CoreLocation cannot bypass GPS or retry indefinitely', async () => {
  const modes = [];
  const fixture = setup({ required: true, onPosition(_success, fail, options) {
    modes.push(options.enableHighAccuracy);
    fail({ code: 2 });
  } });
  await assert.rejects(fixture.api.beginSnapshotMode(), /暫時無法取得 GPS/);
  assert.deepEqual(modes, [true, false]);
  assert.equal(fixture.events.at(-1).status, 'error');
});

test('network-assisted fallback still rejects inaccurate coordinates', async () => {
  const fixture = setup({ required: true, onPosition(success, fail, options) {
    if (options.enableHighAccuracy) fail({ code: 2 });
    else success({ coords: { latitude: 25.03, longitude: 121.56, accuracy: 250 }, timestamp: Date.now() });
  } });
  await assert.rejects(fixture.api.beginSnapshotMode(), /GPS 定位不夠精準/);
  assert.equal(fixture.gpsCalls(), 2);
});

test('missing or unavailable admin policy cannot silently bypass GPS', async () => {
  const fixture = setup({ onPolicy: () => ({}) });
  await assert.rejects(fixture.api.beginSnapshotMode(), /無法確認管理端/);
  assert.equal(fixture.gpsCalls(), 0);
  assert.equal(fixture.events.at(-1).status, 'error');
});

test('exiting snapshot mode while policy loads never requests GPS afterwards', async () => {
  let finish;
  const fixture = setup({ onPolicy: () => new Promise(resolve => { finish = resolve; }) });
  const opening = fixture.api.beginSnapshotMode();
  fixture.api.endSnapshotMode();
  finish({ snapshotLocationRequired: true, snapshotLocations: [{ name: '門市', latitude: 25, longitude: 121, radiusMeters: 100 }] });
  assert.equal(await opening, null);
  assert.equal(fixture.gpsCalls(), 0);
  assert.equal(fixture.events.at(-1).status, 'idle');
});

test('snapshot UI allows upload when admin policy OFF and retries when ON fails', () => {
  const accessible = read('booking/booking-accessible.js');
  const receipt = read('booking/booking-receipt.js');
  const page = read('booking/index.html');
  assert.match(accessible, /beginSnapshotMode\?\.\(\)/);
  assert.match(accessible, /status !== 'ready' && status !== 'optional'/);
  assert.match(accessible, /管理端未要求快照定位/);
  assert.match(accessible, /bookingSnapshotLocationRetry/);
  assert.match(receipt, /if \(!modeLocationRequired\)/);
  assert.match(receipt, /if \(policy\.snapshotLocationRequired !== true\) return freshModeLocation\(\)/);
  assert.match(receipt, /state\.location = await snapshotLocation\(\)/);
  assert.match(page, /id="bookingSnapshotLocationStatus"/);
  assert.match(page, /id="bookingAccessibleUpload"[^>]*disabled/);
});
