const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const member = fs.readFileSync(path.join(root, 'member-system.js'), 'utf8');
const booking = fs.readFileSync(path.join(root, 'booking/common.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'supabase/functions/api/index.ts'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'supabase/functions/_shared/auth-contract.ts'), 'utf8');
const config = {
  supabaseUrl: 'https://fixture.supabase.co',
  supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
  supabasePublishableKey: 'public-key',
  realtimeEnabled: true,
  memberLiffId: 'member-fixture', adminLiffId: 'admin-fixture',
  pointsLiffId: 'points-fixture', eventLiffId: 'event-fixture',
  calendarLiffId: 'calendar-fixture', bookingLiffId: 'booking-fixture'
};

function harness(server, local = new Map(), options = {}) {
  const calls = [];
  const listeners = {};
  let onRealtime;
  const window = {
    crypto: webcrypto, setTimeout: () => 1, clearTimeout: () => {},
    alert: message => calls.push(['alert', message]),
    confirm: () => options.approve === true,
    close: () => calls.push(['close']),
    closed: true,
    location: { replace: () => calls.push(['replace']) },
    localStorage: {
      getItem: key => local.get(key) || null,
      setItem: (key, value) => local.set(key, value),
      removeItem: key => local.delete(key)
    },
    addEventListener: (event, cb) => { listeners[event] = cb; },
    liff: {
      init: async () => {},
      isInClient: () => true,
      isLoggedIn: () => true,
      getIDToken: () => options.token || 'id-token',
      logout: () => calls.push(['logout']),
      closeWindow: () => calls.push(['liff.closeWindow'])
    },
    supabase: {
      createClient: () => ({
        channel: () => ({
          on(_type, _match, cb) { onRealtime = cb; return this; },
          subscribe: () => ({})
        }),
        removeChannel: async () => {}
      })
    }
  };
  const document = {
    visibilityState: 'visible',
    title: 'Member',
    querySelectorAll: () => [],
    addEventListener: (event, cb) => { listeners[event] = cb; }
  };
  const fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(['request', body.action, body.mode]);
    const result = await server(body);
    return { ok: result.ok !== false, status: result.ok === false ? 401 : 200,
      text: async () => JSON.stringify(result.ok === false
        ? { ok: false, status: 401, error: { code: result.code || 'SESSION_REPLACED', message: '已被其他裝置登入取代。' } }
        : { ok: true, status: 200, data: result.data || {} }) };
  };
  vm.runInNewContext(member, { window, document, fetch, URL, AbortController });
  return { window, calls, local, emit: event => onRealtime?.({ new: { scope: 'all', event_type: event } }) };
}

test('single-login takeover: old identity is revalidated immediately after a successful new-device claim', async () => {
  let owner = '';
  const accepted = new Set();
  const server = request => {
    if (request.action.endsWith('.session.claim')) {
      const key = request.browserKey;
      if (owner && owner !== key && request.mode !== 'login') return { ok:false };
      if (owner !== key) accepted.clear();
      owner = key;
      accepted.add(request.idToken);
      return { data:{ state:'claimed' } };
    }
    if (request.action.endsWith('.session.status')) {
      return accepted.has(request.idToken) ? { data:{ state:'active' } } : { ok:false };
    }
    return { data:{} };
  };
  const first = harness(server, new Map(), { token:'device-A' });
  await first.window.MemberSystem.signIn(config, 'member');
  first.window.MemberSystem.subscribeRealtime(config, 'member', () => {});
  const second = harness(server, new Map(), { token:'device-B' });
  await second.window.MemberSystem.signIn(config, 'member');
  first.emit('member.login.replaced');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(first.calls.some(x => x[1] === 'user.member.session.status'));
  assert.equal(first.calls.some(x => x[0] === 'liff.closeWindow'), true);
  assert.equal(first.local.get('member-login-registered-v1'), 'replaced');
  assert.equal(second.calls.some(x => x[0] === 'liff.closeWindow'), false);
});

test('new LIFF login silently replaces an old browser without user-facing takeover confirmation', async () => {
  const local = new Map([['member-login-registered-v1','replaced']]);
  const server = request => ({ data: { state: request.mode === 'login' ? 'replaced' : 'resumed' } });
  const next = harness(server, local, { token:'fresh-new-token', approve:false });
  await next.window.MemberSystem.signIn(config,'member');
  assert.ok(next.calls.some(x => x[1] === 'user.member.session.claim' && x[2] === 'login'));
  assert.equal(next.calls.some(x => x[0] === 'confirm'), false);
  assert.equal(local.get('member-login-registered-v1'), '1');
});

test('a previously registered browser makes a fresh server-verified login claim instead of a denied resume', async () => {
  const local = new Map([['member-login-registered-v1','1']]);
  const next = harness(() => ({data:{ state:'replaced' }}), local, { token:'other-device-new-token' });
  await next.window.MemberSystem.signIn(config,'points');
  assert.ok(next.calls.some(x => x[1] === 'user.points.session.claim' && x[2] === 'login'));
});

test('concurrent realtime takeover notification is not lost during a pending status check', async () => {
  let finishFirstCheck;
  let checks = 0;
  const server = body => {
    if (body.action === 'user.member.session.status') {
      checks++;
      if (checks === 1) return new Promise(resolve => { finishFirstCheck = resolve; });
      return { ok:false, code:'SESSION_REPLACED' };
    }
    return { data:{ state:'claimed' } };
  };
  const previous = harness(server, new Map(), { token:'claimed-token' });
  await previous.window.MemberSystem.signIn(config,'member');
  previous.window.MemberSystem.subscribeRealtime(config,'member', () => {});
  previous.emit('member.login.replaced');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 1, 'first check must be pending');
  previous.emit('member.login.replaced');
  finishFirstCheck({ data:{ state:'active' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 2, 'queued invalidation must trigger a second status check');
  assert.ok(previous.calls.some(x => x[0] === 'liff.closeWindow'));
});

test('session status remains server-authenticated and never opens an admin bypass', () => {
  assert.ok(api.includes('claim|logout|status'), 'member session.status actions must route through authenticated member identity');
  assert.match(api, /return \{ state:"active" \}/);
  assert.match(auth, /if \(!allowLoginClaim && !canBypassUserRestrictions\)/);
  assert.match(auth, /member_login_token_grants/);
  assert.match(booking, /user\.booking\.session\.status/);
  assert.match(booking, /targetScope !== 'admin'/);
  assert.match(member, /member\.login\.replaced'\) verifyCurrentLogin\(\)/);
  assert.doesNotMatch(member, /window\.confirm\(/);
  assert.match(member, /const mode = 'login'/);
});
