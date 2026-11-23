const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../platform/app.js'), 'utf8');
const begin = source.indexOf('  async function request(action, payload = {}) {');
const end = source.indexOf('  function featureRequirements()', begin);
assert.ok(begin >= 0 && end > begin, 'platform request must remain independently testable');
const requestExpression = '(' + source.slice(begin, end).trim() + ')';

function harness(response) {
  const calls = [];
  const idToken = 'synthetic-admin-token';
  const state = {
    config: {
      supabaseFunctionUrl: 'https://bmwhojszsnxliekkhrka.supabase.co/functions/v1/api',
      supabasePublishableKey: 'synthetic-publishable-key'
    },
    idToken
  };
  const context = {
    URL, AbortController, setTimeout, clearTimeout, state,
    merchantEntry: false, rootRevision: 0,
    isV2: () => true,
    uncertainError: () => Object.assign(new Error('Result not confirmed; retry same request'), { uncertain: true }),
    showAuthorizationDenied: () => calls.push(['denied']),
    showLoginGate: message => calls.push(['login-gate', message]),
    offerLineReentry: () => calls.push(['line-reentry']),
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(['fetch', url, body]);
      assert.equal(options.headers.apikey, state.config.supabasePublishableKey);
      assert.equal(body.idToken, idToken);
      return typeof response === 'function' ? response() : response;
    }
  };
  const request = vm.runInNewContext(requestExpression, context);
  return { request, calls, context };
}

test('AC-503-001: review gateway 503 preserves uncertain status and original requestId, without auto-resend', async () => {
  const h = harness({ ok: false, status: 503, json: async () => ({ code: 'EDGE_FUNCTION_ERROR', message: 'Service Unavailable' }) });
  const requestId = '11111111-1111-4111-8111-111111111111';
  await assert.rejects(h.request('platform.qualification.review', { requestId, decision: 'approved' }), e => e.uncertain === true);
  const sent = h.calls.filter(([kind]) => kind === 'fetch');
  assert.equal(sent.length, 1, 'network retry must never be automatic for review writes');
  assert.equal(sent[0][2].requestId, requestId);
  assert.match(sent[0][1], /\/functions\/v1\/platform-api$/);
});

test('AC-503-002: merchant review gateway 502/504 also retains the same mutation identity', async () => {
  for (const status of [502, 504]) {
    const h = harness({ ok: false, status, json: async () => ({ error: { code: 'UPSTREAM_FAILURE' } }) });
    await assert.rejects(h.request('platform.merchant.review', { requestId: '22222222-2222-4222-8222-222222222222' }), e => e.uncertain === true);
    assert.equal(h.calls.filter(([kind]) => kind === 'fetch').length, 1);
  }
});

test('AC-503-003: a known authorization denial must not become an uncertain write', async () => {
  const h = harness({ ok: false, status: 401, json: async () => ({ ok: false, error: { code: 'AUTH_INVALID', message: 'Reauthenticate' } }) });
  await assert.rejects(h.request('platform.qualification.review', { requestId: '33333333-3333-4333-8333-333333333333' }), e => e.status === 401 && !e.uncertain);
  assert.equal(h.calls.filter(([kind]) => kind === 'login-gate').length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'fetch').length, 1);
});

test('AC-503-004: gateway 503 on read-only bootstrap does not claim a review result was uncertain', async () => {
  const h = harness({ ok: false, status: 503, json: async () => ({ code: 'EDGE_FUNCTION_ERROR' }) });
  await assert.rejects(h.request('platform.bootstrap'), e => !e.uncertain && e.status === 503);
  assert.equal(h.calls.filter(([kind]) => kind === 'fetch').length, 1);
});

test('AC-503-005: successful review reads its server result exactly once', async () => {
  const h = harness({ ok: true, status: 200, json: async () => ({ ok: true, data: { qualification: { id: 'synthetic' } } }) });
  const result = await h.request('platform.qualification.review', { requestId: '44444444-4444-4444-8444-444444444444' });
  assert.equal(result.qualification.id, 'synthetic');
  assert.equal(h.context.rootRevision, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'fetch').length, 1);
});
