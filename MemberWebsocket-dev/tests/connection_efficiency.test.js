const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const config = {
  supabaseUrl: 'https://fixture.supabase.co',
  supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
  supabasePublishableKey: 'public-fixture', realtimeEnabled: true,
  memberLiffId: 'member', bookingLiffId: 'booking', adminLiffId: 'admin',
  pointsLiffId: 'points', eventLiffId: 'event', calendarLiffId: 'calendar',
};
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function harness(kind = 'booking') {
  const listeners = new Map(), timers = new Map(), intervals = new Map(), storage = new Map();
  const calls = [], channels = [];
  let nextId = 0, removed = 0;
  let now = 10000;
  class ClockDate extends Date { static now() { return now; } }
  function events(prefix) {
    return {
      addEventListener(type, fn) { const key = prefix + type; if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(fn); },
      removeEventListener(type, fn) { listeners.get(prefix + type)?.delete(fn); },
    };
  }
  const window = {
    ...events('w:'), crypto: webcrypto,
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { const id = ++nextId; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    location: { pathname: '/MemberWebsocket-dev/booking/', href: 'https://fixture.test/booking/' },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    liff: { init: async () => {}, isInClient: () => true, isLoggedIn: () => true, getIDToken: () => 'identity-A' },
    supabase: { createClient() { return {
      channel() { const channel = { on(_event, _filter, fn) { this.change = fn; return this; }, subscribe(fn) { this.status = fn; return this; } }; channels.push(channel); return channel; },
      removeChannel() { removed++; return Promise.resolve(); },
    }; } },
  };
  const document = { ...events('d:'), visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [] };
  const navigator = { onLine: true };
  const response = data => ({ ok: data.ok !== false, status: data.ok === false ? 403 : 200,
    json: async () => data, text: async () => JSON.stringify(data) });
  const fetch = (url, options) => {
    const body = JSON.parse(options.body);
    if (body.action.endsWith('.session.claim') || body.action.includes('.presence.')) return Promise.resolve(response({ ok: true, data: {} }));
    return new Promise((resolve, reject) => calls.push({ url, body, resolve: data => resolve(response(data)), reject }));
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, kind === 'booking' ? '../booking/common.js' : '../member-system.js'), 'utf8'),
    { window, document, navigator, fetch, URL, URLSearchParams, AbortController, console, Date: ClockDate });
  return {
    window, document, navigator, calls, timers, intervals, channels,
    system: kind === 'booking' ? window.BookingSystem : window.MemberSystem,
    advanceClock(ms) { now += ms; },
    emit(type, documentEvent = false) { for (const fn of listeners.get((documentEvent ? 'd:' : 'w:') + type) || []) fn({}); },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    removed: () => removed,
    async signIn() { if (kind === 'booking') await window.BookingSystem.completeSignIn(config, 'member', 'identity-A'); else await window.MemberSystem.signIn(config, 'member'); },
    subscribe(fn = () => {}) { return kind === 'booking' ? window.BookingSystem.subscribeRealtime(config, fn) : window.MemberSystem.subscribeRealtime(config, 'member', fn); },
  };
}
const succeed = (call, data = {}) => call.resolve({ ok: true, data });

for (const kind of ['member', 'booking']) {
  const action = kind === 'member' ? 'user.member.bootstrap' : 'user.booking.slots';
  test(`AC-PERF-001 ${kind}: identical in-flight reads still coalesce and later reads stay fresh`, async () => {
    const h = harness(kind);
    const reads = Array.from({ length: 100 }, () => h.system.request(config, 'member', 'identity-A', action));
    assert.equal(h.calls.length, 1);
    succeed(h.calls[0], { marker: 'first' });
    assert.ok((await Promise.all(reads)).every(value => value.marker === 'first'));
    const fresh = h.system.request(config, 'member', 'identity-A', action);
    assert.equal(h.calls.length, 2); succeed(h.calls[1], { marker: 'fresh' });
    assert.equal((await fresh).marker, 'fresh');
  });
  for (const [field, value] of [['supabasePublishableKey', 'other-public-key'], ['business', 'shop-b']]) {
    test(`AC-PERF-001 ${kind}: different ${field} cannot reuse another in-flight response`, async () => {
      const h = harness(kind), a = { ...config, business: 'shop-a' }, b = { ...a, [field]: value };
      const reads = [a, b].map(cfg => h.system.request(cfg, 'member', 'identity-A', action));
      h.calls.forEach((call, index) => succeed(call, { marker: index }));
      assert.equal(h.calls.length, 2);
      assert.deepEqual((await Promise.all(reads)).map(value => value.marker), [0, 1]);
    });
  }
  test(`AC-PERF-001 ${kind}: a live BusinessContext switch cannot reuse the previous business read`, async () => {
    const h = harness(kind); h.window.BusinessContext = { slug: 'shop-a' };
    const first = h.system.request(config, 'member', 'identity-A', action);
    h.window.BusinessContext.slug = 'shop-b';
    const second = h.system.request(config, 'member', 'identity-A', action);
    h.calls.forEach((call, index) => succeed(call, { marker: index }));
    assert.equal(h.calls.length, 2);
    assert.deepEqual((await Promise.all([first, second])).map(value => value.marker), [0, 1]);
  });
}

async function runScheduledRefresh(h) {
  assert.ok(h.timers.size, 'a data refresh must be scheduled');
  for (let i = 0; i < 10 && h.timers.size; i++) {
    const [id, timer] = [...h.timers.entries()][0];
    h.timers.delete(id);
    h.advanceClock(timer.delay);
    timer.fn();
    await flush();
  }
  assert.equal(h.timers.size, 0, 'refresh scheduling must settle');
}

for (const sdkAvailable of [true, false]) {
  test(`booking: the safety interval reconciles data with SDK ${sdkAvailable ? 'available' : 'unavailable'}`, async () => {
    const h = harness();
    if (!sdkAvailable) h.window.supabase = null;
    let updates = 0;
    const stop = h.subscribe(() => { updates++; });
    for (const tick of h.intervals.values()) tick();
    await runScheduledRefresh(h);
    assert.equal(updates, 1);
    stop();
  });
}

test('booking: periodic reconciliation pauses while hidden or offline', async () => {
  const h = harness();
  let updates = 0;
  const stop = h.subscribe(() => { updates++; });
  h.document.visibilityState = 'hidden';
  for (const tick of h.intervals.values()) tick();
  assert.equal(h.timers.size, 0);
  h.document.visibilityState = 'visible'; h.navigator.onLine = false;
  for (const tick of h.intervals.values()) tick();
  assert.equal(h.timers.size, 0);
  h.navigator.onLine = true;
  for (const tick of h.intervals.values()) tick();
  await runScheduledRefresh(h);
  assert.equal(updates, 1);
  stop();
});

test('booking: periodic and realtime signals preserve one trailing refresh during a slow read', async () => {
  const h = harness();
  let updates = 0, finish;
  const stop = h.subscribe(() => {
    updates++;
    if (updates === 1) return new Promise(resolve => { finish = resolve; });
  });
  for (const tick of h.intervals.values()) tick();
  await runScheduledRefresh(h);
  for (let i = 0; i < 10; i++) {
    for (const tick of h.intervals.values()) tick();
    h.channels[0].change({ new: { scope: 'member' } });
  }
  assert.equal(updates, 1);
  assert.equal(h.timers.size, 0);
  finish(); await flush();
  await runScheduledRefresh(h);
  assert.equal(updates, 2);
  stop();
});

test('booking: a channel error schedules data recovery and disposal blocks late recovery', async () => {
  const h = harness();
  let updates = 0;
  const stop = h.subscribe(() => { updates++; });
  h.channels[0].status('CHANNEL_ERROR');
  await runScheduledRefresh(h);
  assert.equal(updates, 1);
  const lateTick = [...h.intervals.values()][0];
  stop();
  lateTick(); h.channels[0].status('TIMED_OUT');
  assert.equal(h.timers.size, 0);
});

test('booking: explicitly disabled realtime does not enable periodic data reads', async () => {
  const h = harness();
  const stop = h.system.subscribeRealtime({ ...config, realtimeEnabled: false }, () => assert.fail('disabled data refresh'));
  for (const tick of h.intervals.values()) tick();
  assert.equal(h.timers.size, 0);
  stop();
});

test('booking: 100 concurrent identical slot reads send one request and subsequent reads stay fresh', async () => {
  const h = harness();
  const requests = Array.from({ length: 100 }, () => h.system.request(config, 'member', 'identity-A', 'user.booking.slots', { date: '2026-10-14' }));
  assert.equal(h.calls.length, 1);
  succeed(h.calls[0], { slots: ['10:00'] });
  assert.ok((await Promise.all(requests)).every(result => result.slots[0] === '10:00'));
  const fresh = h.system.request(config, 'member', 'identity-A', 'user.booking.slots', { date: '2026-10-14' });
  assert.equal(h.calls.length, 2);
  succeed(h.calls[1], { slots: [] });
  assert.equal((await fresh).slots.length, 0);
});

test('booking: reads isolate LINE identities, test sessions, parameters, endpoint and public key', async () => {
  const h = harness();
  let testToken = 'test-A';
  h.window.TestModeClient = { payload: body => ({ ...body, testSessionToken: testToken }) };
  const read = (cfg = config, token = 'identity-A', payload = {}) => h.system.request(cfg, 'member', token, 'user.booking.slots', payload);
  const requests = [read(), read(config, 'identity-B'), read(config, 'identity-A', { date: 'other' }),
    read({ ...config, supabaseUrl: 'https://other.supabase.co' }), read({ ...config, supabasePublishableKey: 'other-key' })];
  testToken = 'test-B'; requests.push(read());
  assert.equal(h.calls.length, 6);
  h.calls.forEach((call, i) => succeed(call, { index: i }));
  assert.deepEqual((await Promise.all(requests)).map(result => result.index), [0, 1, 2, 3, 4, 5]);
});

test('booking: benefits and member profile reads share only their matching in-flight request', async () => {
  const h = harness();
  const requests = [h.system.bookingBenefits(config, 'identity-A'), h.system.bookingBenefits(config, 'identity-A'),
    h.system.memberProfile(config, 'identity-A'), h.system.memberProfile(config, 'identity-A')];
  assert.equal(h.calls.length, 2);
  succeed(h.calls[0], { items: [] }); succeed(h.calls[1], { profile: { memberId: 'A' } });
  const results = await Promise.all(requests);
  assert.equal(results[2].memberId, 'A'); assert.equal(results[3].memberId, 'A');
});

test('booking: a failed shared read is evicted and can be retried', async () => {
  const h = harness();
  const a = h.system.request(config, 'booking', 'identity-A', 'user.booking.receipt.list');
  const b = h.system.request(config, 'booking', 'identity-A', 'user.booking.receipt.list');
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ ok: false, error: { code: 'FORBIDDEN', message: 'fixture' } });
  const results = await Promise.allSettled([a, b]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'FORBIDDEN'));
  const fresh = h.system.request(config, 'booking', 'identity-A', 'user.booking.receipt.list');
  assert.equal(h.calls.length, 2); succeed(h.calls[1]); await fresh;
});

test('booking: writes are independent and clear reads before and after a mutation', async () => {
  const h = harness();
  const read = () => h.system.request(config, 'booking', 'identity-A', 'user.booking.receipt.list');
  const before = read();
  const writes = [0, 1].map(() => h.system.request(config, 'booking', 'identity-A', 'user.booking.receipt.cancel', { receiptId: 'fixture' }));
  const during = read();
  assert.equal(h.calls.length, 4);
  succeed(h.calls[1]); succeed(h.calls[2]); await Promise.all(writes);
  const after = read(); assert.equal(h.calls.length, 5);
  succeed(h.calls[0]); await before;
  const duplicate = read(); assert.equal(h.calls.length, 5, 'old completion must not evict the new read');
  succeed(h.calls[3]); succeed(h.calls[4]); await Promise.all([during, after, duplicate]);
});

test('booking: unknown actions are never coalesced', async () => {
  const h = harness();
  const requests = [0, 1].map(() => h.system.request(config, 'booking', 'identity-A', 'future.action'));
  assert.equal(h.calls.length, 2); h.calls.forEach(call => succeed(call)); await Promise.all(requests);
});

test('booking: duplicate subscriptions share channel, timer and lifecycle cleanup', async () => {
  const h = harness();
  const stop = h.subscribe(); const duplicate = h.subscribe();
  assert.equal(stop, duplicate); assert.equal(h.channels.length, 1);
  assert.equal(h.intervals.size, 1); assert.equal(h.listenerCount(), 3);
  stop(); stop(); assert.equal(h.intervals.size, 0); assert.equal(h.listenerCount(), 0); assert.equal(h.removed(), 1);
  h.channels[0].change({ new: { scope: 'member' } });
  assert.equal(h.timers.size, 0, 'late events cannot schedule disposed work');
  const next = h.subscribe(); assert.notEqual(next, stop); assert.equal(h.channels.length, 2); next();
});

test('booking: scopes own their channel so member cleanup preserves admin synchronization', () => {
  const h = harness();
  const memberStop = h.subscribe();
  const adminStop = h.system.subscribeRealtime(config, () => {}, 'admin');
  assert.equal(h.channels.length, 2); assert.equal(h.intervals.size, 2);
  memberStop(); assert.equal(h.removed(), 1); assert.equal(h.intervals.size, 1);
  h.channels[1].change({ new: { scope: 'admin' } });
  assert.equal(h.timers.size, 1); adminStop(); assert.equal(h.timers.size, 0); assert.equal(h.removed(), 2);
});

test('booking: SDK-unavailable subscriptions still deduplicate and clean up timers', () => {
  const h = harness(); h.window.supabase = null;
  const stop = h.subscribe(); assert.equal(h.subscribe(), stop);
  assert.equal(h.channels.length, 0); assert.equal(h.intervals.size, 1);
  stop(); assert.equal(h.intervals.size, 0); assert.equal(h.listenerCount(), 0);
});

test('booking: an uncertain snapshot cancellation is never retried or shared', async () => {
  const h = harness();
  const request = h.system.request(config, 'booking', 'identity-A', 'user.booking.receipt.cancel', { receiptId: 'fixture' });
  h.calls[0].reject(new Error('network fixture'));
  await assert.rejects(request, error => error.code === 'API_RESPONSE_UNCERTAIN');
  await flush(); assert.equal(h.calls.length, 1);
});

test('booking: a revoked session closes subscriptions and rejects a late read response', async () => {
  const h = harness(); await h.signIn(); h.subscribe();
  const read = h.system.request(config, 'booking', 'identity-A', 'user.booking.receipt.list');
  h.emit('pageshow');
  h.calls[1].resolve({ ok: false, error: { code: 'SESSION_REPLACED', message: 'fixture' } });
  await flush(); assert.equal(h.system.getSession(), null); assert.equal(h.intervals.size, 0); assert.equal(h.removed(), 1);
  succeed(h.calls[0], { receipts: [] }); await assert.rejects(read, error => error.code === 'SESSION_REVOKED');
});

test('member: SDK-unavailable foreground verification is independent of a slow data refresh', async () => {
  const h = harness('member'); h.window.supabase = null; await h.signIn();
  let finishRefresh;
  const stop = h.subscribe(() => new Promise(resolve => { finishRefresh = resolve; }));
  h.emit('pageshow'); await flush(); assert.equal(h.calls.length, 1);
  h.document.visibilityState = 'hidden'; h.emit('visibilitychange', true);
  h.document.visibilityState = 'visible'; h.emit('visibilitychange', true);
  succeed(h.calls[0]); await flush(); assert.equal(h.calls.length, 2);
  succeed(h.calls[1]); finishRefresh(); await flush(); stop();
});

for (const kind of ['booking', 'member']) {
  test(`${kind}: a pre-background status result cannot replace foreground verification`, async () => {
    const h = harness(kind); await h.signIn(); const stop = h.subscribe(); h.emit('pageshow');
    h.document.visibilityState = 'hidden'; h.emit('visibilitychange', true);
    h.document.visibilityState = 'visible'; h.emit('visibilitychange', true); h.emit('pageshow');
    succeed(h.calls[0]); await flush(); assert.equal(h.calls.length, 2);
    succeed(h.calls[1]); await flush(); stop();
  });
  test(`${kind}: page-resume signals share status verification while takeover still gets a trailing check`, async () => {
    const h = harness(kind); await h.signIn(); const stop = h.subscribe();
    h.emit('pageshow'); h.emit('visibilitychange', true); h.emit('online');
    assert.equal(h.calls.length, 1);
    succeed(h.calls[0]); await flush(); assert.equal(h.calls.length, 1);
    h.emit('pageshow'); assert.equal(h.calls.length, 2);
    h.channels[0].change({ new: { scope: 'all', event_type: 'member.login.replaced' } });
    succeed(h.calls[1]); await flush(); assert.equal(h.calls.length, 3, 'takeover during a check must be revalidated');
    succeed(h.calls[2]); await flush(); stop();
  });
  test(`${kind}: unsubscribe discards queued status checks and late lifecycle callbacks`, async () => {
    const h = harness(kind); await h.signIn(); const stop = h.subscribe();
    h.emit('pageshow'); h.channels[0].change({ new: { scope: 'all', event_type: 'member.login.replaced' } });
    stop(); succeed(h.calls[0]); await flush();
    h.channels[0].change({ new: { scope: 'all', event_type: 'member.login.replaced' } });
    assert.equal(h.calls.length, 1);
  });
}

