const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const source = fs.readFileSync(
  path.join(__dirname, '../supabase/functions/booking-contact-api/index.ts'), 'utf8',
);
const entry = source.indexOf("serveBusiness('booking-contact-api'");
assert.ok(entry >= 0, 'booking-contact-api entrypoint must exist');
const handler = stripTypeScriptTypes(source.slice(entry));

function fixture() {
  let serve, providerCalls = 0, authzCalls = 0, rateLimitCalls = 0, contactsCalls = 0;
  class ApiError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = null;
    }
  }
  vm.runInNewContext(handler, {
    ApiError, Request, Response,
    serveBusiness(_name, fn) { serve = fn; },
    corsHeaders() { return { 'Cache-Control': 'no-store' }; },
    originAllowed() { return true; },
    async readJsonObject(request) { return request.json(); },
    asText(value, max = 1000) { return String(value ?? '').trim().slice(0, max); },
    dbClient() { return {}; },
    async resolveUserTestIdentity(_db, token) {
      return token === 'synthetic-test-session'
        ? { lineUserId: 'U' + 'b'.repeat(32), displayName: 'Synthetic Member' }
        : null;
    },
    TestModeAuthError: class TestModeAuthError extends Error {},
    async verifyLineIdToken(token) {
      providerCalls++;
      assert.equal(typeof token, 'string');
      return { lineUserId: 'U' + 'a'.repeat(32), displayName: 'Synthetic Admin' };
    },
    async consumeRateLimit() { rateLimitCalls++; },
    async authorizeAdmin() { authzCalls++; },
    async requireJoinedMember() { return { id: 'member-a' }; },
    async contactsForIds() { contactsCalls++; return []; },
    requireUuid(value) { return value; },
    response(_origin, data, status = 200) {
      return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    },
    mapDbError(error) {
      return new ApiError(500, 'INTERNAL_ERROR', String(error?.message || 'Internal error'));
    },
  });

  return {
    async request(body) {
      return serve(new Request('https://synthetic.invalid/booking-contact-api', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
    },
    get providerCalls() { return providerCalls; },
    get authzCalls() { return authzCalls; },
    get rateLimitCalls() { return rateLimitCalls; },
    get contactsCalls() { return contactsCalls; },
  };
}

test('SEC-02: malformed LINE ID Tokens are rejected before provider lookup and protected operations', async (t) => {
  for (const [clientType, action] of [
    ['admin', 'admin.booking.contacts'],
    ['member', 'user.booking.contacts'],
  ]) {
    for (const [label, idToken] of [
      ['missing', undefined],
      ['null', null],
      ['number', 123],
      ['object', { token: 'fake' }],
      ['array', ['fake']],
      ['empty', ''],
      ['whitespace', '   '],
      ['oversized', 'x'.repeat(10_001)],
    ]) {
      await t.test(`${clientType}: ${label}`, async () => {
        const f = fixture();
        const res = await f.request({ clientType, action, idToken, bookingIds: [] });
        assert.equal(res.status, 401);
        assert.equal((await res.json()).error.code, 'AUTH_REQUIRED');
        assert.equal(f.providerCalls, 0, 'invalid token must not reach LINE verifier');
        assert.equal(f.rateLimitCalls, 0, 'invalid token must not proceed to account operations');
        assert.equal(f.authzCalls, 0);
        assert.equal(f.contactsCalls, 0);
      });
    }
  }
});

test('SEC-02: valid LINE tokens preserve admin and member action flow', async () => {
  for (const [clientType, action] of [
    ['admin', 'admin.booking.contacts'],
    ['member', 'user.booking.contacts'],
  ]) {
    const f = fixture();
    const res = await f.request({ clientType, action, idToken: 'synthetic-id-token', bookingIds: [] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(f.providerCalls, 1);
    assert.equal(f.rateLimitCalls, 1);
    assert.equal(f.contactsCalls, 1);
    assert.equal(f.authzCalls, clientType === 'admin' ? 1 : 0);
  }
});

test('SEC-02: authorized member test sessions retain their separate identity path', async () => {
  const f = fixture();
  const res = await f.request({
    clientType: 'member', action: 'user.booking.contacts',
    testSessionToken: 'synthetic-test-session', bookingIds: [],
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(f.providerCalls, 0);
  assert.equal(f.rateLimitCalls, 1);
  assert.equal(f.contactsCalls, 1);
});
