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
  const context = vm.createContext({ window, document: { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] },
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
  h.calls.forEach(succeed); await Promise.all(reads); assert.equal(h.calls.length, 5);
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
