const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const common = fs.readFileSync(path.join(__dirname, '../booking/common.js'), 'utf8');
const fresh = fs.readFileSync(path.join(__dirname, '../booking/liff-fresh-login.js'), 'utf8');
const receipt = fs.readFileSync(path.join(__dirname, '../booking/booking-receipt.js'), 'utf8');
const config = {
  supabaseUrl: 'https://fixture.supabase.co',
  supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
  supabasePublishableKey: 'public',
  bookingLiffId: 'test-booking-liff',
  adminLiffId: 'test-admin-liff'
};

function createHarness({ testMode = false, rejectClaim = false, rejectStatus = false } = {}) {
  const calls = [];
  let sessionToken = testMode ? 'fixture-test-session' : '';
  const local = new Map();
  const window = {
    crypto: webcrypto,
    localStorage: {
      getItem(key) { return local.get(key) || null; },
      setItem(key, value) { local.set(key, value); },
      removeItem(key) { local.delete(key); }
    },
    location: { href: 'https://example.test/booking/', pathname: '/booking/', reload() {} },
    history: { replaceState() {} },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {},
    addEventListener() {}, dispatchEvent() {},
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    alert(message) { calls.push(['alert', message]); },
    close() {},
    liff: {
      init: async () => {},
      isInClient: () => true,
      isLoggedIn: () => true,
      getIDToken: () => 'line-verified-id-token',
      logout() {},
      closeWindow() { calls.push(['close']); }
    }
  };
  if (testMode) {
    window.TestModeClient = {
      prepare: async () => ({ idToken: '', testSessionToken: sessionToken }),
      getSessionToken: () => sessionToken,
      payload: body => ({ ...body, testSessionToken: sessionToken }),
      clearSession: () => { sessionToken = ''; }
    };
  }
  const navigator = { onLine: true, sendBeacon: () => true };
  const document = {
    visibilityState: 'visible', title: 'Booking',
    addEventListener() {}, querySelectorAll: () => []
  };
  const fetch = async (_endpoint, init) => {
    const body = JSON.parse(init.body);
    calls.push(['request', body.action, body.idToken, body.testSessionToken || '']);
    const denied = (rejectClaim && body.action === 'user.booking.session.claim')
      || (rejectStatus && body.action === 'user.booking.session.status');
    return {
      ok: !denied, status: denied ? 401 : 200,
      json: async () => denied
        ? { ok:false, error:{code:'SESSION_REPLACED', message:'登入連線遭撤銷'} }
        : { ok:true, data:{state:'active'} },
      clone() { return this; }
    };
  };
  vm.runInNewContext(common, { window, document, navigator, fetch, AbortController, Blob });
  vm.runInNewContext(fresh, { window, document, navigator, fetch, AbortController, Blob, URL });
  return { window, calls, local };
}

test('fresh LINE booking login registers its granted ID token for receipt and snapshot', async () => {
  const h = createHarness();
  const idToken = await h.window.BookingSystem.signIn(config, 'booking');
  assert.equal(idToken, 'line-verified-id-token');
  assert.equal(h.window.BookingSystem.getSession()?.idToken, idToken);
  assert.equal(h.window.BookingSystem.getSession()?.config, config);
  assert.equal(h.calls.filter(x => x[1] === 'user.booking.session.claim').length, 1);
  assert.equal(h.calls.filter(x => x[1] === 'user.booking.presence.online').length, 1);
  assert.match(receipt, /function session\(\) \{\s*return window.BookingSystem\?\.getSession\?\.\(\) \|\| null/);
  assert.equal(h.calls.some(x => x[0] === 'alert'), false);
});

test('failed booking claim cannot create a UI authentication session', async () => {
  const h = createHarness({rejectClaim:true});
  await assert.rejects(
    h.window.BookingSystem.signIn(config,'booking'), {code:'SESSION_REPLACED'}
  );
  assert.equal(h.window.BookingSystem.getSession(), null);
  assert.equal(h.calls.filter(x => x[1] === 'user.booking.presence.online').length, 0);
});

test('test-mode booking without LINE token retains an authenticated test session for snapshot', async () => {
  const h = createHarness({testMode:true});
  const token = await h.window.BookingSystem.signIn(config,'booking');
  assert.equal(token, '');
  assert.ok(h.window.BookingSystem.getSession());
  assert.equal(h.window.BookingSystem.getSession().idToken, '');
  assert.equal(h.calls.filter(x => x[1] === 'user.booking.session.claim').length, 0);
  assert.equal(h.calls.filter(x => x[1] === 'user.booking.presence.online').length, 1);
  assert.equal(h.calls.find(x => x[1] === 'user.booking.presence.online')[3], 'fixture-test-session');
});

test('other booking client types keep original admin behavior and no member Session claim', async () => {
  const h = createHarness();
  const token = await h.window.BookingSystem.signIn(config, 'admin');
  assert.equal(token, 'line-verified-id-token');
  assert.equal(h.window.BookingSystem.getSession(), null);
  assert.equal(h.calls.filter(x => x[1] === 'user.booking.session.claim').length, 0);
});

test('direct normal booking signin also establishes the same receipt session', async () => {
  const h = createHarness();
  const token = await h.window.BookingSystem.completeSignIn(config, 'booking', 'line-verified-id-token');
  assert.equal(h.window.BookingSystem.getSession().idToken, token);
  assert.equal(h.calls.filter(x => x[1] === 'user.booking.session.claim').length, 1);
});

test('no ID token and no test session cannot register a booking session', async () => {
  const h = createHarness();
  await assert.rejects(
    h.window.BookingSystem.completeSignIn(config,'booking',''), { code:'AUTH_REQUIRED' }
  );
  assert.equal(h.window.BookingSystem.getSession(), null);
  assert.equal(h.calls.filter(x => x[1] === 'user.booking.session.claim').length, 0);
});
