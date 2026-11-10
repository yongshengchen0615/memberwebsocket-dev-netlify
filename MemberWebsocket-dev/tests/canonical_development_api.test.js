'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const config = {
  supabaseUrl: 'https://fixture.supabase.co',
  supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
  supabasePublishableKey: 'synthetic-public-key',
  previewApiFunctionUrl: 'https://obsolete.supabase.co/functions/v1/api-preview',
  bookingPreviewApis: true,
  business: 'shop-a',
};
function transport(file, fragment) {
  const calls = [], timers = new Map();
  let response = { ok: true, data: { marker: 'canonical' } };
  const window = {
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener() {}, removeEventListener() {},
    location: { pathname: '/booking/', href: 'https://fixture.test/booking/' },
  };
  const context = vm.createContext({
    window, document: { addEventListener() {}, removeEventListener() {}, querySelector: () => null },
    navigator: { sendBeacon(url, body) { calls.push({ url, beacon: body }); return true; } },
    console, URL, URLSearchParams, AbortController, Blob,
    state: { config, idToken: 'synthetic-identity', catalog: { services: [] } },
    context: async () => ({ config, idToken: 'synthetic-identity' }),
    system: { clientError(code, message) { return Object.assign(new Error(message), { code }); } },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), options });
      return { ok: response.ok, status: response.ok ? 200 : 403,
        text: async () => JSON.stringify(response), json: async () => response };
    },
  });
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (fragment) {
    const start = source.indexOf(fragment.start), end = source.indexOf(fragment.end, start);
    assert.ok(start >= 0 && end > start, 'transport fragment must resolve');
    vm.runInContext(source.slice(start, end), context);
  } else vm.runInContext(source, context);
  return { calls, context, window, timers, reject: () => { response = { ok: false, error: { code: 'FORBIDDEN', message: 'denied' } }; } };
}

test('AC-001: stale preview config cannot redirect booking, receipts, benefits, claims or member data', async () => {
  const h = transport('booking/common.js');
  const system = h.window.BookingSystem;
  await system.request(config, 'member', 'synthetic-identity', 'user.booking.slots', { bookingDate: '2026-11-10' });
  await system.request(config, 'member', 'synthetic-identity', 'user.booking.receipt.prepare', { bookingId: 'booking-a' });
  await system.bookingBenefits(config, 'synthetic-identity');
  await system.claimEventTicket(config, 'synthetic-identity', 'ticket-a');
  await system.memberProfile(config, 'synthetic-identity');
  assert.deepEqual(h.calls.map(call => call.url), [
    'https://fixture.supabase.co/functions/v1/booking-api',
    'https://fixture.supabase.co/functions/v1/booking-receipt-api',
    'https://fixture.supabase.co/functions/v1/api',
    'https://fixture.supabase.co/functions/v1/api',
    'https://fixture.supabase.co/functions/v1/api',
  ]);
  assert.ok(h.calls.every(call => call.body.idToken === 'synthetic-identity'));
  assert.equal(h.calls[1].body.bookingId, 'booking-a');
  assert.equal(h.calls[3].body.eventTicketId, 'ticket-a');
  h.reject();
  await assert.rejects(system.request(config, 'member', 'synthetic-identity', 'user.booking.create'), { code: 'FORBIDDEN' });
  assert.equal(h.calls.length, 6, 'denied writes are never retried');
});

test('AC-001: online presence and page-exit beacon ignore stale preview config', async () => {
  const h = transport('booking/common.js', {
    start: '  function sendPresence(context,', end: '  function bookingNoticeElement()',
  });
  vm.runInContext(`
    function presenceBody(context, event, reason) { return { action: 'user.booking.presence.' + event, idToken: context.idToken, reason }; }
    function clearPresenceHeartbeat() {}
    const presenceContext = { config: ${JSON.stringify(config)}, idToken: 'synthetic-identity', closed: false };
    window.online = () => sendPresence(presenceContext, 'online', 'signin');
    window.offline = () => sendPresenceExit(presenceContext, 'pagehide');
  `, h.context);
  await h.window.online();
  await h.window.offline();
  assert.deepEqual(h.calls.map(call => call.url), Array(2).fill('https://fixture.supabase.co/functions/v1/api'));
  assert.equal(JSON.parse(await h.calls[1].beacon.text()).action, 'user.booking.presence.offline');
});

test('AC-002: group bootstrap, slots, create and update use canonical endpoints with no write replay', async () => {
  const h = transport('booking/group-booking.js', { start: '  async function groupRequest(', end: '  function injectGroupControls()' });
  for (const action of ['user.booking.group.bootstrap', 'user.booking.group.slots', 'user.booking.group.create', 'user.booking.group.update']) {
    const data = await h.context.groupRequest(action, { participants: [{ memberNote: 'note-a' }] });
    assert.equal(data.marker, 'canonical');
  }
  assert.deepEqual(h.calls.map(call => call.url), [
    'https://fixture.supabase.co/functions/v1/booking-group-api',
    'https://fixture.supabase.co/functions/v1/booking-group-slots-api',
    'https://fixture.supabase.co/functions/v1/booking-group-api',
    'https://fixture.supabase.co/functions/v1/booking-group-api',
  ]);
  assert.ok(h.calls.every(call => call.body.idToken === 'synthetic-identity' && call.body.participants[0].memberNote === 'note-a'));
  h.reject();
  await assert.rejects(h.context.groupRequest('user.booking.group.create'), { code: 'FORBIDDEN' });
  assert.equal(h.calls.length, 5);
  assert.equal(h.timers.size, 0);
});

test('AC-003: admin transport keeps canonical API routing and authorization errors', async () => {
  const h = transport('admin/booking-panel-core.js', { start: '  async function requestFunction(', end: '  function isBackgroundE2ERunner()' });
  for (const name of ['booking-api', 'booking-admin-api', 'booking-admin-operations', 'booking-group-api', 'booking-group-details-api', 'booking-contact-api']) {
    await h.context.requestFunction(name, 'admin.booking.bootstrap', { bookingId: 'booking-a' });
  }
  assert.deepEqual(h.calls.map(call => call.url), [
    'https://fixture.supabase.co/functions/v1/booking-api',
    'https://fixture.supabase.co/functions/v1/booking-admin-api',
    'https://fixture.supabase.co/functions/v1/booking-admin-operations',
    'https://fixture.supabase.co/functions/v1/booking-group-api',
    'https://fixture.supabase.co/functions/v1/booking-group-details-api',
    'https://fixture.supabase.co/functions/v1/booking-contact-api',
  ]);
  assert.ok(h.calls.every(call => call.body.clientType === 'admin' && call.body.idToken === 'synthetic-identity' && call.body.bookingId === 'booking-a'));
  h.reject();
  await assert.rejects(h.context.requestFunction('booking-api', 'admin.booking.status.update', {}, true), { code: 'FORBIDDEN' });
  assert.equal(h.calls.length, 7);
  assert.equal(h.timers.size, 0);
});
