const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../member-system.js'), 'utf8');
const entry = 'https://example.test/MemberWebsocket-dev/admin/?view=members#top';
const storageKey = 'member_system_reauth:admin';
const config = {
  realtimeEnabled: false, supabaseUrl: 'https://fixture.supabase.co',
  supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
  supabasePublishableKey: 'fixture-public-key', adminLiffId: 'fixture-admin',
};

function harness({ url = entry, storage = new Map(), loggedIn = true, inClient = false,
  token = 'fixture-id-token', storageBlocked = false, logoutFails = false,
  logoutNoop = false, initFails = false } = {}) {
  const calls = [];
  const location = { href: url };
  const local = new Map();
  const window = {
    location, crypto: webcrypto, setTimeout, clearTimeout,
    localStorage: {
      getItem(key) { return local.get(key) || null; },
      setItem(key, value) { local.set(key, value); },
      removeItem(key) { local.delete(key); },
    },
    sessionStorage: {
      getItem(key) { if (storageBlocked) throw Error('Blocked'); return storage.get(key) || null; },
      setItem(key, value) { if (storageBlocked) throw Error('Blocked'); storage.set(key, value); },
      removeItem(key) { if (storageBlocked) throw Error('Blocked'); storage.delete(key); },
    },
    history: { replaceState(_state, _title, next) { location.href = new URL(next, location.href).href; } },
    liff: {
      async init(value) { calls.push(['init', value.liffId]); if (initFails) throw Error('Init failed'); },
      isInClient: () => inClient,
      isLoggedIn: () => loggedIn,
      logout() {
        calls.push(['logout']);
        if (logoutFails) throw Error('Logout failed');
        if (!logoutNoop) loggedIn = false;
      },
      login(value) {
        calls.push(['login', value.redirectUri]);
        // Simulate leaving the document without an 8-second navigation timeout.
        throw Object.assign(new Error('Navigating'), { code: 'NAVIGATION' });
      },
      getIDToken() { calls.push(['token']); return token; },
    },
  };
  const fetch = async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({ ok: true, data: { state: 'claimed' } }),
  });
  vm.runInNewContext(source, {
    window, fetch, AbortController, document: { title: 'Admin', querySelector: () => ({}) }, URL,
  });
  return { calls, storage, location, signIn: () => window.MemberSystem.signIn(config, 'admin') };
}

async function startLogin(options) {
  const h = harness(options);
  await assert.rejects(h.signIn(), { code: 'NAVIGATION' });
  return { ...h, callback: h.calls.find(([name]) => name === 'login')[1] };
}

test('external entry clears an existing LIFF session before requesting login', async () => {
  const h = await startLogin();
  assert.deepEqual(h.calls.map(([name]) => name), ['init', 'logout', 'login']);
  const callback = new URL(h.callback);
  assert.match(callback.searchParams.get('member_system_reauth'), /^admin\.[a-f0-9]{32}$/);
  assert.equal(callback.searchParams.get('view'), 'members');
  assert.equal(callback.hash, '#top');
  assert.doesNotMatch(JSON.stringify([...h.storage]), /fixture-id-token/);
});

test('a bookmarked legacy login marker cannot skip fresh login', async () => {
  const h = await startLogin({ url: entry.replace('?view=members', '?member_system_reauth=admin') });
  assert.equal(h.calls.some(([name]) => name === 'logout'), true);
  assert.equal(h.calls.some(([name]) => name === 'token'), false);
});

test('matching callback is consumed once; reloading or replaying it requires login', async () => {
  const first = await startLogin();
  const returned = harness({ url: first.callback, storage: first.storage });
  assert.equal(await returned.signIn(), 'fixture-id-token');
  assert.deepEqual(returned.calls.map(([name]) => name), ['init', 'token']);
  assert.equal(first.storage.has(storageKey), false);
  assert.equal(returned.location.href, entry);
  await startLogin({ url: first.callback, storage: first.storage });
  await startLogin({ url: returned.location.href });
});

for (const scenario of ['missing', 'expired', 'future', 'wrong-path', 'wrong-nonce', 'malformed']) {
  test(`invalid callback (${scenario}) never accepts the existing token`, async () => {
    const first = await startLogin();
    const record = JSON.parse(first.storage.get(storageKey));
    if (scenario === 'expired') record.createdAt = Date.now() - 6 * 60 * 1000;
    if (scenario === 'future') record.createdAt = Date.now() + 60 * 1000;
    if (scenario === 'wrong-path') record.pathname = '/other-admin/';
    if (scenario === 'wrong-nonce') record.nonce = '0'.repeat(32);
    first.storage.set(storageKey, scenario === 'malformed' ? 'invalid JSON' : JSON.stringify(record));
    if (scenario === 'missing') first.storage.clear();
    const replay = await startLogin({ url: first.callback, storage: first.storage });
    assert.equal(replay.calls.some(([name]) => name === 'token'), false);
  });
}

test('return without a logged-in session shows an error instead of redirecting forever', async () => {
  const first = await startLogin();
  const returned = harness({ url: first.callback, storage: first.storage, loggedIn: false });
  await assert.rejects(returned.signIn(), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(returned.calls.map(([name]) => name), ['init']);
});

test('missing ID token after callback is rejected', async () => {
  const first = await startLogin();
  const returned = harness({ url: first.callback, storage: first.storage, token: '' });
  await assert.rejects(returned.signIn(), { code: 'AUTH_REQUIRED' });
});

test('blocked browser storage fails closed without accepting an existing token', async () => {
  const h = harness({ storageBlocked: true });
  await assert.rejects(h.signIn(), { code: 'AUTH_STORAGE_UNAVAILABLE' });
  assert.deepEqual(h.calls.map(([name]) => name), ['init', 'logout']);
});

for (const option of ['logoutFails', 'logoutNoop']) {
  test(`${option}: cannot silently reuse the previous login`, async () => {
    const h = harness({ [option]: true });
    await assert.rejects(h.signIn(), { code: 'AUTH_LOGOUT_FAILED' });
    assert.deepEqual(h.calls.map(([name]) => name), ['init', 'logout']);
  });
}

test('LIFF client uses initialized LINE identity without unsupported login redirects', async () => {
  const h = harness({ inClient: true, storageBlocked: false });
  assert.equal(await h.signIn(), 'fixture-id-token');
  assert.deepEqual(h.calls.map(([name]) => name), ['init', 'token']);
  await assert.rejects(harness({ inClient: true, loggedIn: false }).signIn(), { code: 'AUTH_REQUIRED' });
});

test('SDK initialization failure cannot proceed to login or token use', async () => {
  const h = harness({ initFails: true });
  await assert.rejects(h.signIn(), { code: 'LIFF_INIT_ERROR' });
  assert.deepEqual(h.calls.map(([name]) => name), ['init']);
});
