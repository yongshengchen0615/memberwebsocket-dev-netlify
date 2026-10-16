const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

function setup() {
  let callback;
  let errors;
  const cleared = [];
  const events = [];
  const ctx = {
    Date, Math, Number, String, Object, Map, Set, Promise,
    navigator: { geolocation: {
      watchPosition(onFix, onError, opts) {
        callback = onFix; errors = onError;
        assert.equal(opts.maximumAge, 0);
        assert.equal(opts.enableHighAccuracy, true);
        return 0; // Watch ID 0 must be stopped, too.
      },
      clearWatch(id) { cleared.push(id); }
    }},
    window: {
      isSecureContext: true,
      setTimeout, clearTimeout
    }
  };
  vm.runInNewContext(read('ticket-live-location.js'), ctx);
  const watcher = ctx.window.TicketLiveLocation.create({
    onUpdate: (fix, fresh) => events.push({ fix, fresh })
  });
  return { watcher, events, cleared, emit: (data) => callback(data), fail: (e) => errors(e) };
}

test('watchPosition updates live location without refreshing or storing history', async () => {
  const { watcher, events, cleared, emit } = setup();
  const pending = watcher.read();
  emit({ coords: { latitude: 25.033, longitude: 121.5654, accuracy: 24 }, timestamp: Date.now() });
  const fix = await pending;
  assert.equal(fix.accuracy, 24);
  assert.equal(watcher.active(), true);
  emit({ coords: { latitude: 25.0332, longitude: 121.5657, accuracy: 9 }, timestamp: Date.now() });
  assert.equal(events.length, 2);
  assert.equal((await watcher.read()).accuracy, 9);
  watcher.stop();
  assert.deepEqual(cleared, [0]);
  assert.equal(watcher.latest(), null);
});

test('denied GPS permission clears the old watch so a later grant can retry', async () => {
  const { watcher, cleared, fail, emit } = setup();
  const denied = watcher.read();
  fail({ code: 1 });
  await assert.rejects(denied, /定位遭拒/);
  assert.equal(watcher.active(), false);
  assert.deepEqual(cleared, [0]);
  const granted = watcher.read();
  emit({ coords: { latitude: 25.034, longitude: 121.565, accuracy: 7 }, timestamp: Date.now() });
  assert.equal((await granted).accuracy, 7);
  watcher.stop();
  assert.deepEqual(cleared, [0, 0]);
});

test('inaccurate fixes are visible but not accepted for ticket redemption', async () => {
  const { watcher, events, emit } = setup();
  const pending = watcher.read();
  emit({ coords: { latitude: 25.033, longitude: 121.5654, accuracy: 170 }, timestamp: Date.now() });
  assert.equal(events.length, 1);
  assert.equal(events[0].fresh, false);
  emit({ coords: { latitude: 25.034, longitude: 121.5657, accuracy: 20 }, timestamp: Date.now() });
  assert.equal((await pending).accuracy, 20);
  watcher.stop();
});

test('admin location ranges are wired to both member ticket surfaces', () => {
  const event = read('event/app.js');
  const points = read('points/pointcard-ticket-overview.js');
  const admin = read('admin/coupon-location-editor.js');
  const realtime = read('member-system.js');
  const member = read('member/app.js');
  for (const file of ['event/index.html', 'points/index.html', 'admin/index.html']) {
    assert.match(read(file), /ticket-live-location\.js/);
  }
  assert.match(event, /TicketLiveLocation\.evaluate/);
  assert.match(points, /TicketLiveLocation\.evaluate/);
  assert.doesNotMatch(event, /TicketLiveLocation\.placeName/);
  assert.doesNotMatch(points, /TicketLiveLocation\.placeName/);
  assert.match(event, /可使用地點/);
  assert.match(points, /可使用地點/);
  assert.match(admin, /function stopGPS/);
  assert.match(admin, /TicketLiveLocation\.placeName/);
  assert.match(realtime, /periodic-reconcile/);
  assert.match(member, /Subscribe regardless of the initial view/);
});

test('member auto-refresh survives an unavailable Realtime SDK without reloading', async () => {
  let tick;
  let cleared = null;
  let calls = 0;
  const config = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseFunctionUrl: 'https://example.supabase.co/functions/v1/api',
    memberCalendarFunctionUrl: 'https://example.supabase.co/functions/v1/member-calendar-api',
    supabasePublishableKey: 'fixture',
    memberLiffId: 'member', pointsLiffId: 'points', eventLiffId: 'event',
    calendarLiffId: 'calendar', adminLiffId: 'admin'
  };
  const window = {
    setInterval(callback, delay) { assert.equal(delay, 30000); tick = callback; return 42; },
    clearInterval(id) { cleared = id; },
    addEventListener() {}, removeEventListener() {}
  };
  const document = {
    visibilityState: 'visible',
    addEventListener() {}, removeEventListener() {}
  };
  const context = vm.createContext({ window, document, navigator: { onLine: true }, Map, Set, URL, console });
  vm.runInContext(read('member-system.js'), context);
  const unsubscribe = window.MemberSystem.subscribeRealtime(config, 'member', () => { calls += 1; });
  assert.equal(typeof tick, 'function');
  tick();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  document.visibilityState = 'hidden';
  tick();
  await Promise.resolve();
  assert.equal(calls, 1);
  unsubscribe();
  assert.equal(cleared, 42);
});


test('live GPS compares against admin names and radius, not reverse-geocoded device place names', () => {
  const context = { window: {}, Date, Math, Number, String, Object, Map, Set, Promise };
  vm.runInNewContext(read('ticket-live-location.js'), context);
  const geo = context.window.TicketLiveLocation;
  const locations = [{ name: '管理端指定門市', latitude: 25.033, longitude: 121.5654, radiusMeters: 100 }];
  const position = { latitude: 25.033, longitude: 121.5654, accuracy: 15, observedAt: new Date().toISOString() };
  assert.equal(geo.evaluate(position, locations).allowed, true);
  assert.equal(geo.evaluate(position, locations).matched.name, '管理端指定門市');
  assert.equal(geo.evaluate({ ...position, latitude: 25.035 }, locations).reason, 'outside');
  assert.equal(geo.evaluate({ ...position, accuracy: 120 }, locations).reason, 'waiting');
  assert.equal(geo.evaluate(position, []).reason, 'missing');
  assert.equal(geo.evaluate(position, [{ ...locations[0], radiusMeters: 0 }]).reason, 'missing');
  assert.match(geo.allowedLocationLabel(locations), /管理端指定門市/);
});

test('issued tickets receive updated geofences and member APIs expose their current rules', () => {
  const api = read('supabase/functions/api/index.ts');
  const pointMap = api.slice(api.indexOf('function pointTicketClient'), api.indexOf('async function pointBootstrap'));
  const eventMap = api.slice(api.indexOf('function eventTicketClient'), api.indexOf('function claimClient'));
  assert.match(pointMap, /redemptionLocations/);
  assert.match(eventMap, /redemptionLocations/);
  const migration = read('supabase/migrations/20261010233000_realtime_ticket_redemption_location_authority.sql');
  assert.match(migration, /requires_location=t\.requires_location/);
  assert.match(migration, /redemption_locations=case when t\.requires_location/);
  assert.match(migration, /after update of[\s\S]*?requires_location, redemption_locations/);
  assert.match(migration, /pt\.status='available'/);
  assert.match(migration, /fixed_ticket_templates_sync_location/);
});
