const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'member-system.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'supabase/functions/api/index.ts'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'supabase/functions/_shared/auth-contract.ts'), 'utf8');

test('two independent admin LIFF logins do not claim member single-device sessions', async () => {
  const config = {
    realtimeEnabled: false,
    supabaseUrl: 'https://fixture.supabase.co',
    supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
    supabasePublishableKey: 'test-publishable-key',
    adminLiffId: 'admin-fixture',
  };
  async function loginFromBrowser(idToken) {
    const requests = [];
    const window = {
      crypto: webcrypto,
      liff: {
        init: async () => {},
        isInClient: () => true,
        isLoggedIn: () => true,
        getIDToken: () => idToken,
      },
      setTimeout, clearTimeout,
    };
    const fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {} }) };
    };
    vm.runInNewContext(client, {
      window, fetch, URL, AbortController,
      document: { title: 'Admin', querySelector: () => ({}) },
    });
    const token = await window.MemberSystem.signIn(config, 'admin');
    assert.equal(token, idToken);
    assert.equal(requests.length, 0, 'admin sign-in must not submit member session claims');
    await window.MemberSystem.request(config, 'admin', token, 'admin.bootstrap', { lazy: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action, 'admin.bootstrap');
    assert.equal(requests[0].idToken, idToken);
  }
  await Promise.all([loginFromBrowser('admin-device-A'), loginFromBrowser('admin-device-B')]);
});

test('admin-specific claim and logout handlers never touch member session RPCs', () => {
  const start = api.indexOf('if (/^(?:admin|user');
  const stop = api.indexOf('const presence = presenceActionInfo(action);', start);
  assert.ok(start !== -1 && stop > start);
  const block = api.slice(start, stop);
  assert.ok(block.includes('await authorizeAdmin(supabase, identity);\n      return { state:"concurrent" };'));
  assert.ok(block.indexOf('return { state:"concurrent" };') < block.indexOf('member_login_claim'));
  assert.ok(block.includes('if (action === "admin.session.logout") return { revoked:false };'));
  assert.ok(block.indexOf('return { revoked:false };') < block.indexOf('member_login_logout'));
  assert.ok(block.includes('member_login_claim'), 'member single-device flow remains intact');
  assert.ok(block.includes('member_login_logout'), 'member logout revocation remains intact');
});

test('admin exemption needs a server-verified admin identity and admin LINE audience', () => {
  assert.ok(auth.includes('adminResult.data?.role === "admin" && adminResult.data?.status === "active"'));
  assert.ok(auth.includes('const canBypassUserRestrictions = isActiveAdmin && expectedChannelId === adminChannelId'));
  assert.ok(auth.includes('if (!allowLoginClaim && !canBypassUserRestrictions) {'));
  assert.ok(auth.includes('SESSION_REPLACED'));
  assert.ok(client.includes("if (idToken && surface !== 'admin')"), 'only member sessions claim single-device login; admin bypass remains server-verified');
  assert.ok(client.includes("if (active && active[0] !== 'admin')"));
});
