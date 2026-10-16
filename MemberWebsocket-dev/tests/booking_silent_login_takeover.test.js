const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../booking/common.js'), 'utf8');
const config = {
  realtimeEnabled: true,
  supabaseUrl: 'https://fixture.supabase.co',
  supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
  supabasePublishableKey: 'fixture-publishable',
  bookingLiffId: 'booking-fixture', adminLiffId:'admin-fixture'
};

function bookingHarness() {
  const local = new Map([['member-login-registered-v1', '1']]);
  const calls = [];
  const windowListeners = {};
  const documentListeners = {};
  let signedToken = 'fixture-claimed-token';
  let valid = true;
  let realtimeEvent;
  const navigator = { onLine: true, sendBeacon: () => true };
  const document = {
    visibilityState: 'visible',
    addEventListener(name, cb) { (documentListeners[name] ||= []).push(cb); },
    removeEventListener() {},
    querySelectorAll: () => []
  };
  const window = {
    crypto: webcrypto, navigator,
    localStorage: {
      getItem: key => local.get(key) || null,
      setItem: (key, value) => local.set(key, value),
      removeItem: key => local.delete(key)
    },
    setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 2, clearInterval() {},
    addEventListener(name, cb) { (windowListeners[name] ||= []).push(cb); },
    removeEventListener() {}, dispatchEvent() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    alert(message) { calls.push(['alert', message]); },
    confirm() { throw new Error('new login must not prompt'); },
    close() { calls.push(['close']); },
    closed: false, location: { replace() {}, reload() {} },
    liff: {
      init: async () => {}, isLoggedIn: () => true, isInClient: () => true,
      getIDToken: () => signedToken, logout() {},
      closeWindow() { calls.push(['closed']); }
    },
    supabase: {
      createClient: () => ({
        channel: () => ({
          on(_event, _filter, callback) { realtimeEvent = callback; return this; },
          subscribe(callback) { callback('SUBSCRIBED'); return this; },
          unsubscribe() {}
        }),
        removeChannel: async () => {}
      })
    }
  };
  const fetch = async (_endpoint, options) => {
    const body = JSON.parse(options.body);
    calls.push(['request', body.action, body.mode, body.idToken]);
    const denied = body.action === 'user.booking.session.status' && !valid;
    return {
      ok: !denied, status: denied ? 401 : 200,
      json: async () => denied
        ? { ok:false, status:401, error:{ code:'SESSION_REPLACED', message:'舊工作階段已被取代' } }
        : { ok:true, data:{state:'active'} }
    };
  };
  vm.runInNewContext(source, { window, document, navigator, fetch, AbortController, Blob });
  return {
    window, document, calls,
    markRevoked: () => { valid = false; },
    rotateLineToken: () => { signedToken = 'not-yet-granted-refreshed-token'; },
    goBackground: () => {
      document.visibilityState = 'hidden';
      (documentListeners.visibilitychange || []).forEach(cb => cb());
    },
    goForeground: () => {
      document.visibilityState = 'visible';
      (documentListeners.visibilitychange || []).forEach(cb => cb());
    },
    emitTakeover: () => realtimeEvent({ new:{ scope:'all', event_type:'member.login.replaced' } })
  };
}

test('booking new login always sends login mode, without an alert or confirmation', async () => {
  const h = bookingHarness();
  await h.window.BookingSystem.signIn(config,'booking');
  assert.ok(h.calls.some(call => call[1] === 'user.booking.session.claim' && call[2] === 'login'));
  assert.equal(h.calls.some(call => call[0] === 'alert'), false);
});

test('booking backgrounded session receives authenticated takeover rejection and closes on resumed realtime', async () => {
  const h = bookingHarness();
  await h.window.BookingSystem.signIn(config,'booking');
  h.window.BookingSystem.subscribeRealtime(config, () => {});
  h.goBackground();
  h.markRevoked();
  h.emitTakeover();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.some(call => call[1] === 'user.booking.session.status'));
  assert.ok(h.calls.some(call => call[0] === 'closed'));
});

test('booking foreground revalidates after missing a realtime broadcast', async () => {
  const h = bookingHarness();
  await h.window.BookingSystem.signIn(config,'booking');
  h.window.BookingSystem.subscribeRealtime(config, () => {});
  h.goBackground();
  h.markRevoked();
  h.goForeground();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.some(call => call[0] === 'closed'));
});

test('booking heartbeat uses the session-claimed token even if LIFF silently rotates tokens', async () => {
  const h = bookingHarness();
  await h.window.BookingSystem.signIn(config,'booking');
  h.rotateLineToken();
  h.window.BookingSystem.subscribeRealtime(config, () => {});
  h.goForeground();
  await new Promise(resolve => setImmediate(resolve));
  const sessionRequests = h.calls.filter(call => call[1] === 'user.booking.session.status');
  assert.ok(sessionRequests.length >= 1);
  assert.ok(sessionRequests.every(call => call[3] === 'fixture-claimed-token'));
  assert.equal(h.calls.some(call => call[0] === 'closed'), false);
});

test('management client bypasses member single-login claim and revocation', async () => {
  const h = bookingHarness();
  await h.window.BookingSystem.signIn(config,'admin');
  assert.equal(h.calls.some(call => String(call[1]).includes('session.claim')), false);
});
