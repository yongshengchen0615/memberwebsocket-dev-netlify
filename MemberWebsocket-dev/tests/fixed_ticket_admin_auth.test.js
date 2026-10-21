const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '../supabase/functions');
const source = fs.readFileSync(path.join(root, 'fixed-ticket-automation/index.ts'), 'utf8');
const start = source.indexOf('async function verifyAdmin(');
const end = source.indexOf('function normalizeTiers(', start);
assert.ok(start > 0 && end > start, 'fixed-ticket admin verifier must exist');
const verifier = stripTypeScriptTypes(source.slice(start, end));
const lineClaims = () => import(pathToFileURL(path.join(root, '_shared/line-id-claims.mjs')));
const now = Date.now();
const valid = {
  sub: 'U' + 'a'.repeat(32), aud: '2010791619',
  iss: 'https://access.line.me', iat: Math.floor(now / 1000) - 30,
  exp: Math.floor(now / 1000) + 300, name: 'Synthetic Admin',
};

async function fixture(payload = valid, { status = 200, admin = { role: 'admin', status: 'active' }, rejectTenant = false } = {}) {
  const { isVerifiedLineIdClaim } = await lineClaims();
  let queries = 0, providerCalls = 0, tenantChecks = 0;
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  const supabase = { from(table) {
    assert.equal(table, 'admins');
    queries++;
    return { select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: admin, error: null }; } };
  } };
  const context = {
    ApiError, Response, URLSearchParams, AbortSignal, Date,
    env(name) { return name === 'LINE_ADMIN_CHANNEL_ID' ? '2010791619' : ''; },
    asText(value, max = 1000) { return String(value ?? '').trim().slice(0, max); },
    async fetch(url, options) {
      providerCalls++;
      assert.equal(url, 'https://api.line.me/oauth2/v2.1/verify');
      assert.equal(options.body.get('client_id'), '2010791619');
      assert.equal(options.body.get('id_token'), 'synthetic-id-token');
      assert.ok(options.signal instanceof AbortSignal, 'LINE verification must have a timeout');
      return new Response(JSON.stringify(payload), { status });
    },
    businessContext() { return { status: 'active' }; },
    assertTenantIdentity(_context, identity) {
      tenantChecks++;
      if (rejectTenant) throw Object.assign(new Error('TENANT_EXPIRED'), { status: 403, code: 'TENANT_EXPIRED' });
      assert.ok(identity.issuedAtMs > 0);
    },
    isVerifiedLineIdClaim,
  };
  const fn = vm.runInNewContext(verifier + '\nverifyAdmin', context);
  return { call: () => fn(supabase, 'synthetic-id-token'),
    get queries() { return queries; },
    get providerCalls() { return providerCalls; },
    get tenantChecks() { return tenantChecks; } };
}

test('fixed-ticket admin verifies valid LINE claims, current admin role and tenant', async () => {
  const f = await fixture();
  const identity = await f.call();
  assert.equal(identity.lineUserId, valid.sub);
  assert.equal(identity.displayName, valid.name);
  assert.equal(f.providerCalls, 1);
  assert.equal(f.queries, 1);
  assert.equal(f.tenantChecks, 1);
});

test('fixed-ticket admin rejects malformed identity before privileged database access', async () => {
  for (const claims of [null, [], {}, { ...valid, sub: 'not-line-user' },
    { ...valid, aud: '2010787602' }, { ...valid, iss: 'https://invalid.test' },
    { ...valid, iat: Math.floor(now / 1000) + 120 },
    { ...valid, iat: '123' }, { ...valid, iat: 0 },
    { ...valid, exp: '9999999999' }, { ...valid, exp: Math.floor(now / 1000) - 1 },
  ]) {
    const f = await fixture(claims);
    await assert.rejects(f.call(), error => error.status === 401 && error.code === 'AUTH_INVALID');
    assert.equal(f.queries, 0, 'invalid provider claims must never reach admin lookup');
    assert.equal(f.tenantChecks, 0, 'invalid provider claims must never reach tenant authorization');
  }
});

test('fixed-ticket admin rejects provider failures, revoked tenant and inactive admin', async () => {
  for (const args of [
    [valid, { status: 400 }, 401, 'AUTH_INVALID'],
    [valid, { rejectTenant: true }, 403, 'TENANT_EXPIRED'],
    [valid, { admin: { role: 'none', status: 'pending' } }, 403, 'ADMIN_REQUIRED'],
  ]) {
    const f = await fixture(args[0], args[1]);
    await assert.rejects(f.call(), error => error.status === args[2] && error.code === args[3]);
  }
});
