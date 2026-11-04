const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/member-profile-api/index.ts'), 'utf8')
  .replace(/^import .*\n/gm, '');

function harness(options = {}) {
  const member = {
    id: 'member-otp-test', line_user_id: 'line-otp-test', display_name: 'Member',
    member_code: 'M00001', status: 'active', membership_status: 'pending',
    joined_at: null, created_at: '2026-01-01T00:00:00Z', is_test_account: false,
  };
  const terms = {
    id: 'terms-otp-test', version: 'v1', title: '會員條款', summary: '條款',
    body: '完整條款', status: 'active', scope: 'production', required: true,
    effective_at: '2020-01-01T00:00:00Z', activated_at: '2026-01-01T00:00:00Z', reconsent_existing: false,
  };
  let handler;
  let requests = [];
  let limitAllowed = true;
  let twilioUnavailable = false;
  let required = options.required !== false;
  const verifiedCode = '123456';
  const db = {
    rpc(name, args) {
      if (name === 'consume_api_rate_limit') return Promise.resolve({ data: limitAllowed, error: null });
      if (name === 'member_service_minute_totals') return Promise.resolve({ data: [{ member_id: member.id, total_minutes: 0 }], error: null });
      if (name === 'accept_membership_terms_api') {
        const payload = args.p_payload;
        if (!payload.accepted) return Promise.resolve({ data: null, error: { message: 'TERMS_CONSENT_REQUIRED' } });
        if (payload.termsId !== terms.id || payload.termsVersion !== terms.version) {
          return Promise.resolve({ data: null, error: { message: 'TERMS_VERSION_STALE' } });
        }
        Object.assign(member, {
          membership_status: 'active', joined_at: '2026-11-04T00:00:00Z',
          birthday: payload.birthday, phone: payload.phone, surname: payload.surname,
          salutation: payload.salutation,
        });
        return Promise.resolve({ data: true, error: null });
      }
      throw new Error('Unexpected RPC: ' + name);
    },
    from(table) {
      let row = table === 'members' ? member : table === 'membership_terms' ? terms : null;
      const query = {
        select() { return query; },
        eq() { return query; },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); },
        single() { return Promise.resolve({ data: row, error: null }); },
        order() { return Promise.resolve({ data: [], error: null }); },
        update(patch) { Object.assign(member, patch); row = member; return query; },
      };
      return query;
    },
  };
  async function mockTwilioFetch(url, options) {
    const address = String(url);
    assert.match(address, /^https:\/\/verify\.twilio\.com\/v2\/Services\/VA[a-f0-9]{32}\/Verification/);
    assert.equal(options.method, 'POST');
    assert.match(String(options.headers.Authorization), /^Basic /);
    requests.push({ address, to: options.body.get('To'), code: options.body.get('Code'), channel: options.body.get('Channel') });
    if (twilioUnavailable) return new Response(JSON.stringify({ code: 500 }), { status: 500 });
    if (address.endsWith('/Verifications')) {
      return new Response(JSON.stringify({ status: 'pending' }), { status: 201 });
    }
    return new Response(JSON.stringify({ status: options.body.get('Code') === verifiedCode ? 'approved' : 'pending' }), { status: 200 });
  }
  const context = vm.createContext({
    Deno: {
      serve(callback) { handler = callback; },
      env: {
        get(name) {
          if (name === 'SUPABASE_URL') return 'https://example.supabase.co';
          if (name === 'SUPABASE_SERVICE_ROLE_KEY') return 'fixture-service-key';
          if (name === 'TWILIO_VERIFY_REQUIRED') return required ? 'true' : 'false';
          if (name === 'TWILIO_VERIFY_SERVICE_SID') return 'VA' + 'a'.repeat(32);
          if (name === 'TWILIO_API_KEY_SID') return 'SK' + 'b'.repeat(32);
          if (name === 'TWILIO_API_KEY_SECRET') return 'fixture-secret-not-production';
          return '';
        },
      },
    },
    createClient: () => db,
    readJsonObject: (request) => request.json(),
    resolveUserTestIdentity: async () => ({ lineUserId: member.line_user_id, displayName: member.display_name }),
    TestModeAuthError: class extends Error {},
    verifyLineIdTokenContract: async () => ({ lineUserId: member.line_user_id, displayName: member.display_name }),
    fetch: mockTwilioFetch,
    btoa: (s) => Buffer.from(s).toString('base64'),
    URLSearchParams, AbortSignal, TextEncoder, crypto: require('node:crypto').webcrypto,
    Date, Response, console,
  });
  vm.runInContext(stripTypeScriptTypes(source), context);
  async function call(action, payload = {}) {
    const res = await handler(new Request('https://example.invalid', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, clientType: 'member', testSessionToken: 'synthetic', ...payload }),
    }));
    return { status: res.status, body: await res.json() };
  }
  return {
    call, member, requests,
    setRateLimit(allowed) { limitAllowed = allowed; },
    setRequired(value) { required = value; },
    setTwilioUnavailable(value) { twilioUnavailable = value; },
  };
}
const join = {
  birthday: '1991-01-01', phone: '+886912345678', surname: '林', salutation: 'ms',
  termsId: 'terms-otp-test', termsVersion: 'v1', accepted: true,
};

test('AC-001: new member bootstrap advertises required verification', async () => {
  const h = harness();
  const result = await h.call('user.member.bootstrap');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.phoneVerificationRequired, true);
  assert.equal(h.member.membership_status, 'pending');
});

test('AC-002: sending OTP uses verified member and E.164 phone over Twilio Verify SMS', async () => {
  const h = harness();
  const result = await h.call('user.member.phone.send', { phone: '0912345678' });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.sent, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].to, '+886912345678');
  assert.equal(h.requests[0].channel, 'sms');
  assert.equal(h.member.membership_status, 'pending');
});

test('AC-003/004: join is denied before verification and after incorrect code', async () => {
  const h = harness();
  const missing = await h.call('user.member.profile.save', join);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'PHONE_OTP_REQUIRED');
  assert.equal(h.member.membership_status, 'pending');
  const wrong = await h.call('user.member.profile.save', { ...join, otpCode: '555555' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'PHONE_OTP_INVALID');
  assert.equal(h.member.membership_status, 'pending');
});

test('AC-005: successful phone verification activates the existing member', async () => {
  const h = harness();
  const sent = await h.call('user.member.phone.send', { phone: join.phone });
  assert.equal(sent.status, 200);
  const result = await h.call('user.member.profile.save', { ...join, otpCode: '123456' });
  assert.equal(result.status, 200);
  assert.equal(h.member.membership_status, 'active');
  assert.equal(h.member.phone, join.phone);
  assert.equal(result.body.data.profile.membershipRequired, false);
  assert.equal(h.requests.filter(x => x.address.endsWith('/VerificationCheck')).length, 1);
});

test('AC-006: verification failure never activates a pending member', async () => {
  const h = harness();
  h.setTwilioUnavailable(true);
  const sent = await h.call('user.member.phone.send', { phone: join.phone });
  assert.equal(sent.status, 503);
  assert.equal(sent.body.error.code, 'PHONE_VERIFY_UNAVAILABLE');
  const finish = await h.call('user.member.profile.save', { ...join, otpCode: '123456' });
  assert.equal(finish.status, 503);
  assert.equal(h.member.membership_status, 'pending');
});

test('AC-007: rate limits and invalid destinations block SMS sends', async () => {
  const h = harness();
  const landline = await h.call('user.member.phone.send', { phone: '+886223456789' });
  assert.equal(landline.status, 400);
  assert.equal(landline.body.error.code, 'PHONE_MOBILE_REQUIRED');
  const otherCountry = await h.call('user.member.phone.send', { phone: '+14155552671' });
  assert.equal(otherCountry.status, 400);
  assert.equal(otherCountry.body.error.code, 'PHONE_COUNTRY_UNAVAILABLE');
  h.setRateLimit(false);
  const limited = await h.call('user.member.phone.send', { phone: join.phone });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  assert.equal(h.requests.length, 0);
});

test('AC-008: existing members are not forced to reverify when feature is enabled', async () => {
  const h = harness({ required: false });
  const joined = await h.call('user.member.profile.save', join);
  assert.equal(joined.status, 200);
  assert.equal(h.member.membership_status, 'active');
  h.setRequired(true);
  const refresh = await h.call('user.member.bootstrap');
  assert.equal(refresh.body.data.phoneVerificationRequired, true);
  const send = await h.call('user.member.phone.send', { phone: join.phone });
  assert.equal(send.status, 403);
  assert.equal(send.body.error.code, 'PHONE_VERIFY_NOT_ALLOWED');
  assert.equal(h.requests.length, 0);
});

test('AC-009: disabled flag retains legacy join without performing Twilio calls', async () => {
  const h = harness({ required: false });
  assert.equal((await h.call('user.member.bootstrap')).body.data.phoneVerificationRequired, false);
  const result = await h.call('user.member.profile.save', join);
  assert.equal(result.status, 200);
  assert.equal(h.requests.length, 0);
});

test('AC-010: old generic API explicitly blocks unverified first-join route', () => {
  const legacy = fs.readFileSync(path.join(__dirname, '../supabase/functions/api/index.ts'), 'utf8');
  assert.match(legacy, /PHONE_VERIFICATION_REQUIRED/);
  assert.match(legacy, /member\.membership_status !== "active" && \(businessEnv\("TWILIO_VERIFY_REQUIRED"\)/);
});
