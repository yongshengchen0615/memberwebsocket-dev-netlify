const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual frontdesk transport, without starting LINE Login or
// creating any real booking, account, or network traffic.
const app = fs.readFileSync(path.join(__dirname, '../frontdesk/app.js'), 'utf8');
const requestStart = app.indexOf(' async function request(action,body={}){');
const readStart = app.indexOf(' const frontdeskReadActions=');
const requestEnd = app.indexOf(' function clearPrivateHistory(){', requestStart);
assert.ok(requestStart > 0 && requestEnd > requestStart, 'frontdesk request boundary exists');
function harness() {
  const calls = [];
  const context = {
    config: { supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api', supabasePublishableKey: 'public-a' },
    business: 'shop-a', idToken: 'identity-a', AbortSignal,
    fetch(url, init) {
      return new Promise((resolve, reject) => calls.push({ url, init, body: JSON.parse(init.body), resolve, reject }));
    },
  };
  vm.runInNewContext(app.slice(readStart >= 0 && readStart < requestStart ? readStart : requestStart, requestEnd) +
    '\nthis.frontdeskRequest=request;this.reads=typeof pendingReads === "undefined" ? null : pendingReads;', context);
  const succeed = (index, data = {}) => calls[index].resolve({
    status: 200, ok: true, json: async () => ({ ok: true, data }),
  });
  const refuse = (index, status, code) => calls[index].resolve({
    status, ok: false, json: async () => ({ ok: false, error: { code, message: code } }),
  });
  return { calls, context, reads: context.reads, succeed, refuse, request: (action, body = {}) => context.frontdeskRequest(action, body) };
}

for (const action of ['frontdesk.public', 'frontdesk.bootstrap', 'frontdesk.bookings', 'frontdesk.history', 'frontdesk.sync.status']) {
  test('AC-001 ' + action + ': overlapping identical reads share one HTTP call, never a settled cache', async () => {
    const h = harness();
    const reads = Array.from({ length: 100 }, () => h.request(action, { bookingId: 'booking-a' }));
    assert.equal(h.calls.length, 1, 'one in-flight HTTP request');
    h.succeed(0, { revision: '123' });
    await Promise.all(reads);
    const fresh = h.request(action, { bookingId: 'booking-a' });
    assert.equal(h.calls.length, 2, 'next read after settlement must reach the server');
    h.succeed(1);
    await fresh;
    assert.equal(h.reads.size, 0, 'settled read releases its in-flight entry');
  });
}

test('AC-002: tenant, token, endpoint, public key, action and parameters isolate read requests', async () => {
  const h = harness();
  const requests = [h.request('frontdesk.bookings')];
  h.context.idToken = 'identity-b'; requests.push(h.request('frontdesk.bookings'));
  h.context.business = 'shop-b'; requests.push(h.request('frontdesk.bookings'));
  h.context.config.supabasePublishableKey = 'public-b'; requests.push(h.request('frontdesk.bookings'));
  h.context.config.supabaseFunctionUrl = 'https://other.supabase.co/functions/v1/api';
  requests.push(h.request('frontdesk.bookings'));
  requests.push(h.request('frontdesk.history'));
  requests.push(h.request('frontdesk.bookings', { bookingId: 'booking-b' }));
  assert.equal(h.calls.length, 7);
  h.calls.forEach((_, index) => h.succeed(index));
  await Promise.all(requests);
  assert.equal(h.reads.size, 0);
});

test('AC-003: writes are independent and invalidate pre-existing read coalescing both before and after settlement', async () => {
  const h = harness(), body = { bookingId: 'booking-a', requestId: 'stable-id-1' };
  const old = h.request('frontdesk.bookings');
  const writeA = h.request('frontdesk.booking.update', body);
  const writeB = h.request('frontdesk.booking.update', body);
  const during = h.request('frontdesk.bookings');
  assert.equal(h.calls.length, 4, 'two independent writes and two separate read generations');
  h.succeed(1); h.succeed(2); await Promise.all([writeA, writeB]);
  const after = h.request('frontdesk.bookings');
  assert.equal(h.calls.length, 5, 'write settlement must not reuse a possibly stale read');
  h.succeed(0); await old;
  const duplicate = h.request('frontdesk.bookings');
  assert.equal(h.calls.length, 5, 'stale finally must not evict the newer read');
  h.succeed(3); h.succeed(4);
  await Promise.all([during, after, duplicate]);
  assert.equal(h.reads.size, 0);
});

test('AC-004: failed or denied reads are not cached, and HTTP denial details remain intact', async () => {
  const h = harness();
  const first = h.request('frontdesk.history'), shared = h.request('frontdesk.history');
  assert.equal(h.calls.length, 1);
  h.refuse(0, 403, 'FRONTDESK_REVIEW_REQUIRED');
  for (const pending of [first, shared]) {
    await assert.rejects(pending, { code: 'FRONTDESK_REVIEW_REQUIRED', denied: true });
  }
  assert.equal(h.reads.size, 0);
  const retry = h.request('frontdesk.history');
  assert.equal(h.calls.length, 2);
  h.succeed(1); await retry;
});

test('AC-005: network-uncertain mutations are sent only once, never combined with reads or replayed', async () => {
  const h = harness();
  const writing = h.request('frontdesk.booking.reject-phone', { requestId: 'stable-id-1' });
  assert.equal(h.calls.length, 1);
  h.calls[0].reject(new TypeError('network disconnected'));
  await assert.rejects(writing, { uncertain: true });
  assert.equal(h.calls.length, 1);
  const read = h.request('frontdesk.bootstrap');
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[1].init.signal, 'read keeps the original bounded deadline');
  h.succeed(1); await read;
});
