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
const handlerSource = stripTypeScriptTypes(source.replace(/^import[^\n]*\n/gm, ''));
const lineClaims = () => import(pathToFileURL(path.join(root, '_shared/line-id-claims.mjs')));
const now = 1_800_000_000_000;

test('review: unrelated fixed-template edits preserve omitted calendar settings after grant revocation',async()=>{
 let handler,saved;const current={id:'T',fixed_ticket_id:'FT-1',title:'Old',calendar_enabled:true,status:'active',updated_at:'v1'};
 const db={from(){const q={select(){return q;},eq(){return q;},is(){return q;},maybeSingle:async()=>({data:current,error:null}),update(patch){saved=patch;return q;},single:async()=>({data:{...current,...saved},error:null})};return q;}};
 const sandbox={Response,Request,Date,Intl,console,crypto:require('node:crypto').webcrypto,businessEnv:()=>'',serveBusiness(_name,fn){handler=fn;},fixtureDb:db};
 const ctx=vm.createContext(sandbox);vm.runInContext(handlerSource,ctx);
 vm.runInContext("dbClient=()=>fixtureDb;verifyAdmin=async()=>({lineUserId:'fixture'});audit=async()=>{};listTemplates=async()=>[]",ctx);
 const response=await handler(new Request('https://fixture.test',{method:'POST',body:JSON.stringify({action:'admin.fixed-tickets.save',template:{fixedTicketId:'FT-1',title:'Archived title',description:'Description',usageMethod:'Use',usageInstructions:'Instructions',status:'archived',scheduleType:'birthday_month',accent:'#112233',allowedTierKeys:['general']}})}));
 assert.equal(response.status,200);assert.equal(saved.title,'Archived title');assert.equal(saved.status,'archived');assert.equal(saved.calendar_enabled,true);
});
class FixtureDate extends Date { static now() { return now; } }
const valid = {
  sub: 'U' + 'a'.repeat(32), aud: '2010791619',
  iss: 'https://access.line.me', iat: Math.floor(now / 1000) - 30,
  exp: Math.floor(now / 1000) + 300, name: 'Synthetic Admin',
};

async function fixture(payload = valid, {
  status = 200, admin = { role: 'admin', status: 'active' },
  rejectTenant = false, networkError = false, malformedJson = false, databaseError = false,
} = {}) {
  const { isVerifiedLineIdClaim } = await lineClaims();
  let queries = 0, providerCalls = 0, tenantChecks = 0;
  let handler;
  const requests = [], filters = [];
  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }
  const supabase = { from(table) {
    assert.equal(table, 'admins');
    queries++;
    return { select() { return this; }, eq(column, value) { filters.push([column, value]); return this; },
      async maybeSingle() { return { data: admin, error: databaseError ? { message: 'private database detail' } : null }; } };
  } };
  const context = {
    ApiError, Response, URLSearchParams, AbortSignal, Date: FixtureDate,
    env(name) { return name === 'LINE_ADMIN_CHANNEL_ID' ? '2010791619' : ''; },
    asText(value, max = 1000) { return String(value ?? '').trim().slice(0, max); },
    async fetch(url, options) {
      providerCalls++;
      requests.push({ url, options });
      if (networkError) throw new Error('private provider detail');
      return new Response(malformedJson ? '{invalid-json' : JSON.stringify(payload), { status });
    },
    businessContext() { return { status: 'active' }; },
    assertTenantIdentity(_context, identity) {
      tenantChecks++;
      if (rejectTenant) throw Object.assign(new Error('TENANT_EXPIRED'), { status: 403, code: 'TENANT_EXPIRED' });
      assert.ok(identity.issuedAtMs > 0);
    },
    isVerifiedLineIdClaim: (claims, channel) => isVerifiedLineIdClaim(claims, channel, now),
    businessEnv(name) {
      return { SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key', LINE_ADMIN_CHANNEL_ID: valid.aud }[name] || '';
    },
    createClient() { return supabase; },
    serveBusiness(_name, callback) { handler = callback; },
  };
  const fn = vm.runInNewContext(verifier + '\nverifyAdmin', context);
  vm.runInNewContext(handlerSource, { ...context });
  return { call: (token = 'synthetic-id-token') => fn(supabase, token), requests, filters,
    request: (token) => handler(new Request('https://synthetic.invalid/fixed-ticket-automation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'admin.fixed-tickets.list', idToken: token }),
    })),
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
  assert.deepEqual(f.filters, [['line_user_id', valid.sub]]);
  assert.equal(f.requests[0].url, 'https://api.line.me/oauth2/v2.1/verify');
  assert.equal(f.requests[0].options.body.get('client_id'), valid.aud);
  assert.equal(f.requests[0].options.body.get('id_token'), 'synthetic-id-token');
  assert.ok(f.requests[0].options.signal instanceof AbortSignal, 'LINE verification must have a timeout');
});

test('fixed-ticket admin rejects malformed identity before privileged database access', async (t) => {
  for (const [name, claims] of [
    ['null', null], ['array', []], ['empty object', {}],
    ['invalid subject', { ...valid, sub: 'not-line-user' }],
    ['wrong channel', { ...valid, aud: '2010787602' }],
    ['wrong issuer', { ...valid, iss: 'https://invalid.test' }],
    ['future issue time', { ...valid, iat: Math.floor(now / 1000) + 120 }],
    ['coerced issue time', { ...valid, iat: '123' }],
    ['missing issue time', { ...valid, iat: undefined }],
    ['zero issue time', { ...valid, iat: 0 }],
    ['coerced expiry', { ...valid, exp: '9999999999' }],
    ['expired', { ...valid, exp: Math.floor(now / 1000) - 1 }],
  ]) {
    await t.test(name, async () => {
      const f = await fixture(claims);
      await assert.rejects(f.call(), error => error.status === 401 && error.code === 'AUTH_INVALID');
      assert.equal(f.queries, 0, 'invalid provider claims must never reach admin lookup');
      assert.equal(f.tenantChecks, 0, 'invalid provider claims must never reach tenant authorization');
    });
  }
});

test('fixed-ticket admin rejects provider failures, revoked tenant and inactive admin', async () => {
  for (const args of [
    [valid, { status: 400 }, 401, 'AUTH_INVALID'],
    [valid, { rejectTenant: true }, 403, 'TENANT_EXPIRED'],
    [valid, { admin: { role: 'none', status: 'pending' } }, 403, 'ADMIN_REQUIRED'],
    [valid, { admin: { role: 'admin', status: 'suspended' } }, 403, 'ADMIN_REQUIRED'],
    [valid, { admin: { role: 'none', status: 'active' } }, 403, 'ADMIN_REQUIRED'],
    [valid, { admin: null }, 403, 'ADMIN_REQUIRED'],
  ]) {
    const f = await fixture(args[0], args[1]);
    await assert.rejects(f.call(), error => error.status === args[2] && error.code === args[3]);
  }
});

test('fixed-ticket admin rejects missing, nonstring and oversized tokens before contacting LINE', async () => {
  for (const token of ['', null, 123, {}, 'x'.repeat(10_001)]) {
    const f = await fixture();
    await assert.rejects(f.call(token), error => error.status === 401 && error.code === 'AUTH_REQUIRED');
    assert.equal(f.providerCalls, 0);
    assert.equal(f.queries, 0);
  }
});

test('fixed-ticket HTTP handler rejects raw token types and length without coercion or truncation', async () => {
  for (const token of [null, 123, {}, 'x'.repeat(10_001)]) {
    const f = await fixture();
    const response = await f.request(token);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'AUTH_REQUIRED');
    assert.equal(f.providerCalls, 0);
    assert.equal(f.queries, 0);
  }
});

test('fixed-ticket admin handles network and malformed JSON without database access or secret leakage', async () => {
  for (const [options, status, code] of [
    [{ networkError: true }, 503, 'LINE_AUTH_UNAVAILABLE'],
    [{ malformedJson: true }, 401, 'AUTH_INVALID'],
  ]) {
    const f = await fixture(valid, options);
    await assert.rejects(f.call(), error => error.status === status && error.code === code && !/private|synthetic-id-token/.test(error.message));
    assert.equal(f.queries, 0);
    assert.equal(f.tenantChecks, 0);
  }
});

test('fixed-ticket admin fails closed when current admin authorization cannot be read', async () => {
  const f = await fixture(valid, { databaseError: true });
  await assert.rejects(f.call(), error => error.status === 500 && error.code === 'DATABASE_ERROR' && !/private/.test(error.message));
});
