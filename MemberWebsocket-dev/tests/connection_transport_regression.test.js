const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const config = {
  supabaseUrl: 'https://fixture.supabase.co', supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
  supabasePublishableKey: 'public-fixture', memberLiffId: 'member', bookingLiffId: 'booking',
  adminLiffId: 'admin', pointsLiffId: 'points', eventLiffId: 'event', calendarLiffId: 'calendar',
};
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function harness(kind = 'booking', network) {
  const calls = [], timers = new Map(); let nextTimer = 0;
  const window = {
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); if (delay < 1000) queueMicrotask(fn); return id; },
    clearTimeout(id) { timers.delete(id); }, addEventListener() {}, removeEventListener() {},
    location: { href: 'https://fixture.test/booking/', pathname: '/booking/' },
  };
  const context = vm.createContext({ window, document: { addEventListener() {}, removeEventListener() {}, querySelector: () => null, getElementById: () => null, querySelectorAll: () => [] },
    navigator: {}, URL, URLSearchParams, AbortController, console,
    fetch(url, options) {
      const call = { url, options, body: JSON.parse(options.body) }; calls.push(call);
      if (network) return network(call, calls.length);
      return new Promise((resolve, reject) => Object.assign(call, { resolve(data = {}, status = 200) {
        resolve({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
      }, reject }));
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, kind === 'member' ? '../member-system.js' : '../booking/common.js'), 'utf8'), context);
  const system = kind === 'member' ? window.MemberSystem : window.BookingSystem;
  return { calls, timers, window, context, system,
    request: (action, payload = {}, cfg = config, token = 'identity-A') => system.request(cfg, 'member', token, action, payload) };
}
const succeed = call => call.resolve({ ok: true, data: { marker: call.body.idToken } });

const crudActions = [
  ['admin', 'admin.service-grants.add'],
  ['admin', 'admin.member.update'],
  ['admin', 'admin.tickets.delete'],
  ['admin', 'admin.member.force-logout'],
  ['points', 'user.pointcard.snapshot-ticket.cancel'],
  ['event', 'user.event.snapshot-ticket.cancel'],
  ['booking', 'user.booking.event-ticket.claim'],
  ['points', 'member.friend.lookup'],
  ['admin', 'admin.future-resource.create'],
  ['admin', 'admin.session.status'],
];
for (const [clientType, action] of crudActions) {
  for (const failure of ['network', 'malformed']) test(`CRUD AC-001 ${action}: ${failure} cannot replay a mutation`, async () => {
    const h = harness('member', async () => {
      if (failure === 'network') throw new TypeError('connection lost after commit');
      return { ok: true, status: 200, text: async () => '<html>gateway interrupted</html>' };
    });
    await assert.rejects(h.system.request(config, clientType, 'identity-A', action, { requestId: 'same-operation' }), { code: 'API_RESPONSE_UNCERTAIN' });
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
  });
  test(`CRUD AC-001 ${action}: separate mutations are not coalesced`, async () => {
    const h = harness('member');
    const writes = Array.from({ length: 2 }, () => h.system.request(config, clientType, 'identity-A', action, { requestId: 'same-operation' }));
    h.calls.forEach(succeed);
    await Promise.all(writes);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(call => call.body.requestId === 'same-operation'));
  });
  test(`CRUD AC-002 ${action}: write boundaries invalidate shared reads`, async () => {
    const h = harness('member');
    const read = () => h.system.request(config, clientType, 'identity-A', 'user.member.bootstrap');
    const old = read();
    const write = h.system.request(config, clientType, 'identity-A', action);
    const during = read();
    const duringCount = h.calls.length;
    h.calls.find(call => call.body.action === action).resolve({ ok: true, data: {} });
    await write;
    const fresh = read();
    const afterCount = h.calls.length;
    succeed(h.calls[0]); await old;
    const sharedFresh = read();
    const lateCount = h.calls.length;
    h.calls.forEach(succeed); await Promise.all([during, fresh, sharedFresh]);
    assert.equal(duringCount, 3);
    assert.equal(afterCount, 4);
    assert.equal(lateCount, 4, 'old completion must not evict the current shared read');
  });
}

test('CRUD AC-002 member: session status checks cannot reuse an older pending status', async () => {
  const h = harness('member');
  const checks = [h.request('user.member.session.status'), h.request('user.member.session.status')];
  h.calls.forEach(succeed); await Promise.all(checks);
  assert.equal(h.calls.length, 2);
});

for (const [clientType, action] of [['points', 'user.pointcard.booking-selections.detail'], ['event', 'user.event.booking-selections.detail']]) {
  test(`CRUD AC-002 ${action}: detail reads coalesce and remain safely retryable`, async () => {
    const h = harness('member');
    const reads = Array.from({ length: 100 }, () => h.system.request(config, clientType, 'identity-A', action));
    h.calls.forEach(succeed); await Promise.all(reads);
    assert.equal(h.calls.length, 1);
    const failing = harness('member', async (_call, count) => {
      if (count === 1) throw new TypeError('read connection lost');
      return { ok: true, status: 200, text: async () => '{"ok":true,"data":{"loaded":true}}' };
    });
    const result = await failing.system.request(config, clientType, 'identity-A', action);
    assert.equal(result.loaded, true);
    assert.equal(failing.calls.length, 2);
  });
}

function adminExtensionHarness(network) {
  const h = harness('member', network);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../admin/grant-automation.js'), 'utf8'), h.context);
  return h;
}

test('CRUD AC-002 loaded grant extension: reads are invalidated before and after the actual grant endpoint settles', async () => {
  const h = adminExtensionHarness();
  const read = () => h.window.MemberSystem.request(config, 'admin', 'identity-A', 'admin.bootstrap');
  const old = read();
  const write = h.window.MemberSystem.request(config, 'admin', 'identity-A', 'admin.member-grants.add', { requestId: 'grant-once', points: 2 });
  const during = read();
  const grant = h.calls.find(call => call.body.action === 'admin.member-grants.add');
  assert.equal(grant.url, config.supabaseUrl + '/functions/v1/grant-automation');
  assert.equal(grant.body.notificationMode, 'immediate');
  assert.equal(grant.body.requestId, 'grant-once');
  assert.equal(grant.body.points, 2);
  const duringCount = h.calls.length;
  grant.resolve({ ok: true, data: { granted: true } });
  assert.equal((await write).granted, true);
  const fresh = read();
  const afterCount = h.calls.length;
  h.calls.forEach(succeed); await Promise.all([old, during, fresh]);
  assert.equal(duringCount, 3);
  assert.equal(afterCount, 4);
  assert.equal(h.timers.size, 0);
});

test('CRUD AC-001 loaded grant extension: uncertain grants are not replayed and failures release reads', async () => {
  const h = adminExtensionHarness();
  const old = h.window.MemberSystem.request(config, 'admin', 'identity-A', 'admin.members.list');
  const write = h.window.MemberSystem.request(config, 'admin', 'identity-A', 'admin.member-grants.add', { requestId: 'grant-once' });
  const rejected = assert.rejects(write, { code: 'API_RESPONSE_UNCERTAIN' });
  h.calls.find(call => call.body.action === 'admin.member-grants.add').reject(new TypeError('lost after commit'));
  await rejected;
  const fresh = h.window.MemberSystem.request(config, 'admin', 'identity-A', 'admin.members.list');
  const count = h.calls.length;
  h.calls.forEach(succeed); await Promise.all([old, fresh]);
  assert.equal(count, 3);
  assert.equal(h.calls.filter(call => call.body.action === 'admin.member-grants.add').length, 1);
});

for (const [status, data] of [
  [502, {}], [200, null], [200, []], [200, { ok: false }], [503, { ok: true, data: {} }],
  [200, { ok: true }], [200, { ok: true, data: null }], [200, { ok: true, data: 'gateway body' }],
  [200, { ok: true, data: [] }], [200, { ok: true, data: false }],
  [200, { ok: true, data: {}, error: { code: 'DATABASE_ERROR', message: 'contradictory response' } }],
]) {
  test(`CRUD AC-001 incomplete HTTP ${status} envelope ${JSON.stringify(data)} keeps mutation uncertainty`, async () => {
    const h = harness('member');
    const write = h.system.request(config, 'admin', 'identity-A', 'admin.tickets.delete');
    h.calls[0].resolve(data, status);
    await assert.rejects(write, { code: 'API_RESPONSE_UNCERTAIN' });
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
  });
}

function businessTransportHarness(network) {
  const h = harness('member', network);
  h.window.location = new URL('https://fixture.test/admin/?business=shop-a');
  h.context.location = h.window.location;
  h.context.document.documentElement = {};
  h.window.fetch = h.context.fetch;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../business-context.js'), 'utf8'), h.context);
  h.context.fetch = (...args) => h.window.fetch(...args);
  return h;
}

test('CRUD AC-002 real business decorator: a read cannot retry into another merchant', async () => {
  const h = businessTransportHarness();
  const read = h.system.request(config, 'admin', 'identity-A', 'admin.calendar-items.list');
  const rejected = assert.rejects(read, { code: 'REQUEST_SCOPE_CHANGED' });
  assert.equal(h.calls[0].body.business, 'shop-a');
  h.window.BusinessContext.set('shop-b');
  h.calls[0].reject(new TypeError('connection lost'));
  // A faulty retry must settle too, so the test observes the wrong merchant
  // instead of remaining stuck behind a deliberately pending fetch fixture.
  await flush();
  h.calls.slice(1).forEach(succeed);
  await rejected;
  assert.equal(h.calls.length, 1);
});

for (const backToStart of [false, true]) test(`CRUD AC-002 real business decorator: late results are discarded across merchant generation changes (${backToStart})`, async () => {
  const h = businessTransportHarness();
  const old = h.system.request(config, 'admin', 'identity-A', 'admin.calendar-items.list');
  const rejected = assert.rejects(old, { code: 'REQUEST_SCOPE_CHANGED' });
  h.window.BusinessContext.set('shop-b');
  if (backToStart) h.window.BusinessContext.set('shop-a');
  const fresh = h.system.request(config, 'admin', 'identity-A', 'admin.calendar-items.list');
  h.calls.forEach(succeed);
  await rejected;
  await fresh;
  assert.equal(h.calls.length, 2);
});

test('CRUD AC-002 a new signed-in session cannot consume an older pending read', async () => {
  const h = harness('member');
  const old = h.system.request(config, 'admin', 'identity-A', 'admin.calendar-items.list');
  const rejected = assert.rejects(old, { code: 'REQUEST_SCOPE_CHANGED' });
  h.window.liff = { init: async () => {}, isInClient: () => true, isLoggedIn: () => true, getIDToken: () => 'identity-B' };
  await h.system.signIn(config, 'admin');
  succeed(h.calls[0]);
  await rejected;
  assert.equal(h.system.getSession('admin').idToken, 'identity-B');
});

test('CRUD AC-002 OA checks observe each current LINE access token independently', async () => {
  const h = harness('member');
  let accessToken = 'access-A';
  h.window.liff = { getAccessToken: () => accessToken };
  const first = h.request('user.member.oa.check');
  accessToken = 'access-B';
  const second = h.request('user.member.oa.check');
  h.calls.forEach(call => call.resolve({ ok: true, data: { checked: call.body.lineAccessToken } }));
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.checked), ['access-A', 'access-B']);
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
});

test('CRUD AC-002 a replacement session with the same ID token starts a fresh shared read', async () => {
  const h = harness('member');
  h.window.liff = { init: async () => {}, isInClient: () => true, isLoggedIn: () => true, getIDToken: () => 'identity-A' };
  await h.system.signIn(config, 'admin');
  const read = () => h.system.request(config, 'admin', 'identity-A', 'admin.calendar-items.list');
  const old = read();
  await h.system.signIn(config, 'admin');
  const fresh = read();
  const settled = Promise.allSettled([old, fresh]);
  h.calls[0].resolve({ ok: true, data: { current: false } });
  await old.catch(() => {});
  const sharedFresh = read();
  h.calls.slice(1).forEach(call => call.resolve({ ok: true, data: { current: true } }));
  const results = await settled;
  await sharedFresh;
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.code, 'REQUEST_SCOPE_CHANGED');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[1].value.current, true);
  assert.equal(sharedFresh, fresh, 'old session cleanup must preserve the new shared read');
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
});

for (const code of ['SESSION_REVOKED', 'SESSION_REPLACED', 'MEMBER_REMOVED', 'SYSTEM_MAINTENANCE']) {
  test(`CRUD AC-002 current-session ${code} still terminates access and blocks late results`, async () => {
    const h = harness('member');
    h.window.liff = { init: async () => {}, isInClient: () => true, isLoggedIn: () => true, getIDToken: () => 'identity-A' };
    await h.system.signIn(config, 'admin');
    const slow = h.system.request(config, 'admin', 'identity-A', 'admin.calendar-items.list');
    const denied = h.system.request(config, 'admin', 'identity-A', 'admin.members.list');
    h.calls[1].resolve({ ok: false, error: { code, message: 'current session denial' } }, 403);
    await assert.rejects(denied, { code });
    succeed(h.calls[0]);
    await assert.rejects(slow, { code: 'SESSION_REVOKED' });
    await assert.rejects(h.system.request(config, 'admin', 'identity-A', 'admin.calendar-items.list'), { code: 'SESSION_REVOKED' });
    assert.equal(h.calls.length, 2);
    assert.equal(h.timers.size, 0);
  });

  test(`CRUD AC-002 late ${code} from another merchant cannot terminate the current merchant`, async () => {
    const h = businessTransportHarness();
    const old = h.system.request(config, 'member', 'identity-A', 'user.member.bootstrap');
    const oldResult = old.then(() => null, error => error.code);
    h.window.BusinessContext.set('shop-b');
    const fresh = h.system.request(config, 'member', 'identity-A', 'user.member.bootstrap');
    const freshResult = fresh.then(data => ({ data }), error => ({ error: error.code }));
    h.calls[0].resolve({ ok: false, error: { code, message: 'old merchant denial' } }, 503);
    const staleCode = await oldResult;
    succeed(h.calls[1]);
    const current = await freshResult;
    assert.equal(staleCode, 'REQUEST_SCOPE_CHANGED');
    assert.equal(current.error, undefined);
    assert.equal(current.data.marker, 'identity-A');
    const next = h.system.request(config, 'member', 'identity-A', 'user.member.bootstrap');
    succeed(h.calls[2]);
    assert.equal((await next).marker, 'identity-A');
    assert.equal(h.calls.length, 3);
    assert.equal(h.timers.size, 0);
  });
}

for (const [action, endpoint] of [['user.booking.group.bootstrap', 'booking-group-api'], ['user.booking.group.slots', 'booking-group-slots-api']]) {
  test(`AC-001 ${action}: 100 concurrent reads share one canonical request and later reads are fresh`, async () => {
    const h = harness(); const reads = Array.from({ length: 100 }, () => h.request(action, { bookingDate: '2026-11-11' }));
    const firstCount = h.calls.length; h.calls.forEach(succeed); await Promise.all(reads);
    const fresh = h.request(action, { bookingDate: '2026-11-11' }); succeed(h.calls.at(-1)); await fresh;
    assert.equal(firstCount, 1); assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].url, `${config.supabaseUrl}/functions/v1/${endpoint}`);
    assert.equal(h.timers.size, 0);
  });
}

test('AC-002 group slots separate credentials, merchant, keys, parameters and live merchant changes', async () => {
  const h = harness(), action = 'user.booking.group.slots';
  h.window.BusinessContext = { slug: 'shop-a' };
  const reads = [h.request(action), h.request(action, {}, config, 'identity-B'),
    h.request(action, {}, { ...config, supabasePublishableKey: 'other-key' }), h.request(action, { bookingDate: '2026-11-12' })];
  h.window.BusinessContext.slug = 'shop-b'; reads.push(h.request(action));
  h.calls.forEach(succeed);
  const results = await Promise.allSettled(reads);
  assert.ok(results.slice(0, 4).every(result => result.status === 'rejected' && result.reason.code === 'REQUEST_SCOPE_CHANGED'));
  assert.equal(results[4].status, 'fulfilled');
  assert.equal(h.calls.length, 5);
  h.window.BusinessContext = null;
  const a = h.request(action, {}, { ...config, business: 'a' }), b = h.request(action, {}, { ...config, business: 'b' });
  h.calls.slice(5).forEach(succeed); await Promise.all([a, b]); assert.equal(h.calls.length, 7);
});

for (const action of ['user.booking.group.create', 'user.booking.group.update']) {
  test(`AC-003 ${action}: writes invalidate reads before and after settlement without sharing`, async () => {
    const h = harness(), read = () => h.request('user.booking.group.slots');
    const old = read(), writes = [h.request(action), h.request(action)], during = read();
    const countDuring = h.calls.length;
    h.calls.slice(1, 3).forEach(succeed); await Promise.all(writes);
    const after = read(); const countAfter = h.calls.length;
    succeed(h.calls[0]); await old;
    const duplicate = read(); const countAfterOld = h.calls.length;
    h.calls.forEach(succeed); await Promise.all([during, after, duplicate]);
    assert.equal(countDuring, 4); assert.equal(countAfter, 5); assert.equal(countAfterOld, 5);
  });
}

test('AC-003 group read failures are not cached or retried, including rate limiting', async () => {
  const h = harness();
  for (const [status, code] of [[403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [503, 'SERVICE_UNAVAILABLE']]) {
    const before = h.calls.length;
    const reads = [h.request('user.booking.group.slots'), h.request('user.booking.group.slots')];
    h.calls.slice(before).forEach(call => call.resolve({ ok: false, error: { code, message: 'fixture' } }, status));
    const results = await Promise.allSettled(reads);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === code));
    assert.equal(h.calls.length - before, 1);
  }
});

for (const [kind, actions] of [['member', ['user.member.card.open', 'user.member.invitation.claim']], ['booking', ['user.booking.group.create', 'user.booking.group.update']]]) {
  for (const action of actions) {
    for (const failure of ['network', 'malformed']) test(`AC-004 ${action}: ${failure} produces one uncertain write without replay`, async () => {
      const h = harness(kind, async (_call, count) => {
        if (count === 1) {
          if (failure === 'network') throw new TypeError('connection lost');
          return { ok: true, status: 200, text: async () => '<html>bad gateway</html>', json: async () => { throw new SyntaxError('invalid JSON'); } };
        }
        return { ok: true, status: 200, text: async () => '{"ok":true}', json: async () => ({ ok: true }) };
      });
      await assert.rejects(h.request(action), { code: 'API_RESPONSE_UNCERTAIN' }); await flush();
      assert.equal(h.calls.length, 1);
    });
    test(`AC-004 ${action}: concurrent writes remain independent`, async () => {
      const h = harness(kind), writes = [h.request(action), h.request(action)];
      h.calls.forEach(succeed); await Promise.all(writes); assert.equal(h.calls.length, 2);
    });
    test(`AC-004 ${action}: controlled deadline aborts once and clears the timer`, async () => {
      let aborted = false;
      const h = harness(kind, call => new Promise((_resolve, reject) => {
        call.options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('fixture abort'), { name: 'AbortError' }));
        });
      }));
      const pending = h.request(action);
      const rejection = assert.rejects(pending, { code: 'API_RESPONSE_UNCERTAIN' });
      const timers = [...h.timers.values()]; assert.equal(timers.length, 1);
      assert.equal(timers[0].delay, kind === 'member' ? 30000 : 15000);
      timers[0].fn(); await rejection; await flush();
      assert.equal(aborted, true); assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
    });
    for (const status of [403, 429, 503]) test(`AC-003 ${action}: explicit HTTP ${status} refusal is never replayed`, async () => {
      const h = harness(kind);
      const pending = h.request(action);
      h.calls[0].resolve({ ok: false, error: { code: 'REFUSED', message: 'fixture' } }, status);
      await assert.rejects(pending, { code: 'REFUSED' }); await flush();
      assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
    });
  }
}

test('AC-005 revoked group responses prevent later requests and reject late successes', async () => {
  const h = harness();
  const slow = h.request('user.booking.group.slots', { bookingDate: '2026-11-11' });
  const revoked = h.request('user.booking.group.bootstrap');
  h.calls[1].resolve({ ok: false, error: { code: 'SESSION_REVOKED', message: 'fixture' } }, 401);
  await assert.rejects(revoked, { code: 'SESSION_REVOKED' });
  succeed(h.calls[0]); await assert.rejects(slow, { code: 'SESSION_REVOKED' });
  await assert.rejects(h.request('user.booking.group.slots'), { code: 'SESSION_REVOKED' });
  assert.equal(h.calls.length, 2);
});

for (const action of ['user.booking.create', 'user.booking.group.update', 'user.booking.receipt.finalize', 'user.booking.future.delete']) {
  for (const envelope of [{ ok: true }, { ok: true, data: null }, { ok: true, data: [] }, { ok: true, data: {}, error: { code: 'DATABASE_ERROR' } }, { ok: false }]) {
    test(`CRUD-LOG AC-001 ${action}: incomplete/contradictory ${JSON.stringify(envelope)} is uncertain`, async () => {
      const h = harness('booking');
      const pending = h.request(action);
      h.calls[0].resolve(envelope);
      await assert.rejects(pending, { code: 'API_RESPONSE_UNCERTAIN' });
      assert.equal(h.calls.length, 1);
      assert.equal(h.timers.size, 0);
    });
  }
}

test('CRUD-LOG AC-001 booking: HTTP failure cannot acknowledge a committed mutation', async () => {
  const h = harness('booking');
  const pending = h.request('user.booking.group.create');
  h.calls[0].resolve({ ok: true, data: { bookingId: 'saved' } }, 500);
  await assert.rejects(pending, { code: 'API_RESPONSE_UNCERTAIN' });
  assert.equal(h.calls.length, 1);
});

test('CRUD-LOG AC-002 booking: late merchant success cannot update the current scope', async () => {
  const h = harness('booking');
  h.window.BusinessContext = { slug: 'merchant-a', generation: 1 };
  const read = h.request('user.booking.group.bootstrap');
  const write = h.request('user.booking.group.create');
  h.window.BusinessContext.slug = 'merchant-b'; h.window.BusinessContext.generation++;
  h.calls.forEach(succeed);
  await assert.rejects(read, { code: 'REQUEST_SCOPE_CHANGED' });
  await assert.rejects(write, { code: 'API_RESPONSE_UNCERTAIN' });
  assert.equal(h.timers.size, 0);
});

test('CRUD-LOG AC-002 booking: merchant generation prevents reusing a previous pending read', async () => {
  const h = harness('booking');
  h.window.BusinessContext = { slug: 'merchant-a', generation: 1 };
  const old = h.request('user.booking.group.slots');
  h.window.BusinessContext.generation += 2;
  const fresh = h.request('user.booking.group.slots');
  h.calls.forEach(succeed);
  await assert.rejects(old, { code: 'REQUEST_SCOPE_CHANGED' });
  assert.equal((await fresh).marker, 'identity-A');
  assert.equal(h.calls.length, 2);
});

test('CRUD-LOG AC-002 booking: stale maintenance denial cannot terminate a new merchant', async () => {
  const h = harness('booking');
  h.window.BusinessContext = { slug: 'merchant-a', generation: 1 };
  const old = h.request('user.booking.group.bootstrap');
  h.window.BusinessContext.slug = 'merchant-b'; h.window.BusinessContext.generation++;
  h.calls[0].resolve({ ok: false, error: { code: 'SYSTEM_MAINTENANCE', message: 'old merchant' } }, 503);
  await assert.rejects(old, { code: 'REQUEST_SCOPE_CHANGED' });
  const fresh = h.request('user.booking.group.bootstrap');
  succeed(h.calls[1]);
  assert.equal((await fresh).marker, 'identity-A');
});

function activeBookingHarness(network) {
  const h = harness('booking', network);
  h.window.confirm = () => true;
  h.window.MembershipProgress = { render() {} };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../booking/member-ui.js'), 'utf8'), h.context);
  return h;
}

test('CRUD-LOG AC-001 loaded member UI: cancellation cannot synthesize success from a missing result', async () => {
  const h = activeBookingHarness(async call => ({ ok: true, status: 200, json: async () =>
    call.body.action === 'member.request' ? { ok: true } : { ok: true, data: { bookings: [{ bookingId: 'booking-A', status: 'confirmed' }] } } }));
  await assert.rejects(h.request('user.booking.cancel', { bookingId: 'booking-A' }), { code: 'API_RESPONSE_UNCERTAIN' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.action, 'member.request');
  assert.equal(h.timers.size, 0);
});

test('CRUD-LOG AC-002 loaded member UI: delayed cancellation enrichment cannot release old merchant bookings', async () => {
  const h = activeBookingHarness();
  h.window.BusinessContext = { slug: 'merchant-a', generation: 1 };
  const pending = h.request('user.booking.bootstrap');
  h.calls[0].resolve({ ok: true, data: { bookings: [{ bookingId: 'booking-A', status: 'confirmed' }] } });
  await flush();
  assert.equal(h.calls[1].body.action, 'member.list');
  h.window.BusinessContext.slug = 'merchant-b'; h.window.BusinessContext.generation++;
  h.calls[1].resolve({ ok: true, data: { cancellationMode: 'approval', requests: [] } });
  await assert.rejects(pending, { code: 'REQUEST_SCOPE_CHANGED' });
  assert.equal(h.timers.size, 0);
});

for (const data of [{}, { request: {} }, { request: { bookingId: 'other-booking' } }]) {
  test(`CRUD-LOG AC-001 loaded member UI: cancellation result ${JSON.stringify(data)} cannot fake a requested cancellation`, async () => {
    const h = activeBookingHarness(async call => ({ ok: true, status: 200, json: async () => ({ ok: true, data:
      call.body.action === 'member.request' ? data : { bookings: [{ bookingId: 'booking-A', status: 'confirmed' }] } }) }));
    await assert.rejects(h.request('user.booking.cancel', { bookingId: 'booking-A' }), { code: 'API_RESPONSE_UNCERTAIN' });
    assert.equal(h.calls.length, 1);
  });
}

test('CRUD-LOG AC-001 loaded member UI: failed readback after cancellation acknowledgment stays uncertain and forwards test session', async () => {
  const h = activeBookingHarness(async call => {
    if (call.body.action === 'member.request') return { ok: true, status: 200, json: async () => ({ ok: true, data: { request: { bookingId: 'booking-A' } } }) };
    throw new TypeError('readback disconnected');
  });
  h.window.TestModeClient = { payload: body => ({ ...body, testSessionToken: 'synthetic-session' }) };
  await assert.rejects(h.request('user.booking.cancel', { bookingId: 'booking-A' }), { code: 'API_RESPONSE_UNCERTAIN' });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].body.testSessionToken, 'synthetic-session');
  assert.equal(h.timers.size, 0);
});
