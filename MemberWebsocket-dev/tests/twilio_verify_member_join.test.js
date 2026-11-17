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
    updated_at: '2026-11-01T00:00:00Z', phone_verified_e164: null, phone_verified_at: null,
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
  let claimedPhone = null;
  let conflictOnCommit = false;
  const verifiedCode = '123456';
  const db = {
    rpc(name, args) {
      if (name === 'member_commit_verified_phone') {
        if (conflictOnCommit) return Promise.resolve({ data: null, error: { code: '23505', message: 'members_verified_phone_unique' } });
        if (args.p_join_payload) {
          return db.rpc('accept_membership_terms_api', { p_payload: args.p_join_payload }).then(result => {
            if (result.error) return result;
            member.phone = args.p_phone;
            member.phone_verified_e164 = args.p_phone;
            member.phone_verified_at = '2026-11-04T00:00:00Z';
            member.updated_at = '2026-11-04T00:00:00Z';
            return { data: { ...member }, error: null };
          });
        }
        if (args.p_expected_updated_at !== member.updated_at) return Promise.resolve({ data: null, error: { message: 'PROFILE_CONFLICT' } });
        member.phone = args.p_phone;
        member.phone_verified_e164 = args.p_phone;
        member.phone_verified_at = '2026-11-04T00:00:00Z';
        member.updated_at = '2026-11-04T00:00:00Z';
        return Promise.resolve({ data: { ...member }, error: null });
      }
      if (name === 'save_member_profile_audited') {
        const fields = args.p_fields || {};
        if (args.p_expected_updated_at !== member.updated_at) return Promise.resolve({ data: null, error: { message: 'PROFILE_CONFLICT' } });
        Object.assign(member, fields);
        if ('phone' in fields) { member.phone_verified_e164 = null; member.phone_verified_at = null; }
        member.updated_at = '2026-11-05T00:00:00Z';
        return Promise.resolve({ data: { ...member }, error: null });
      }
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
        eq(key, value) {
          if (table === 'members' && key === 'phone_verified_e164') {
            row = claimedPhone === value ? { id: 'another-member' } : null;
          }
          return query;
        },
        neq(key, value) { if (row && row[key] === value) row = null; return query; },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); },
        single() { return Promise.resolve({ data: row, error: null }); },
        order() { return Promise.resolve({ data: [], error: null }); },
        update(patch) { Object.assign(member, patch); row = member; return query; },
      };
      return query;
    },
  };
  async function mockTwilioFetch(url, request) {
    if (options.provider === 'bird') {
      const payload = JSON.parse(request.body);
      requests.push({ address: String(url), payload, method: request.method, authorization: request.headers.Authorization, timeout: request.signal });
      if (options.networkError) throw new Error('fixture network failure');
      if (options.rawResponse) return new Response(options.rawResponse, { status: options.remoteStatus || 200 });
      if (options.remoteStatus) return new Response(JSON.stringify({ error: { message: 'fixture-upstream-secret' } }), { status: options.remoteStatus });
      if (options.remoteBody) return new Response(JSON.stringify(options.remoteBody), { status: 200 });
      if (String(url).endsWith('/check')) return new Response(JSON.stringify({ success: payload.code === verifiedCode, reason: payload.code === verifiedCode ? null : 'incorrect_code' }), { status: 200 });
      return new Response(JSON.stringify({ status: 'pending', last_channel: 'sms' }), { status: 200 });
    }
    const address = String(url);
    assert.match(address, /^https:\/\/verify\.twilio\.com\/v2\/Services\/VA[a-f0-9]{32}\/Verification/);
    assert.equal(request.method, 'POST');
    assert.match(String(request.headers.Authorization), /^Basic /);
    requests.push({ address, to: request.body.get('To'), code: request.body.get('Code'), channel: request.body.get('Channel') });
    if (twilioUnavailable) return new Response(JSON.stringify({ code: 500 }), { status: 500 });
    if (address.endsWith('/Verifications')) {
      return new Response(JSON.stringify({ status: 'pending' }), { status: 201 });
    }
    return new Response(JSON.stringify({ status: request.body.get('Code') === verifiedCode ? 'approved' : 'pending' }), { status: 200 });
  }
  const context = vm.createContext({
    Deno: {
      serve(callback) { handler = callback; },
      env: {
        get(name) {
          if (Object.hasOwn(options.env || {}, name)) return options.env[name];
          if (options.provider === 'bird') {
            if (name === 'PHONE_VERIFY_PROVIDER') return 'bird';
            if (name === 'PHONE_VERIFY_REQUIRED') return required ? 'true' : 'false';
            if (name === 'BIRD_API_KEY') return 'bk_us1_fixture-not-a-real-key';
            if (name === 'TWILIO_VERIFY_REQUIRED') return 'false';
          }
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
    businessContext: () => null,
    memberOaGuidance: () => ({ required: false, configured: false, friend: false }),
    InvitationError: class extends Error {},
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
    setTestAccount(value) { member.is_test_account = value; },
    setClaimedPhone(value) { claimedPhone = value; },
    setCommitConflict(value) { conflictOnCommit = value; }
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
  assert.equal(send.status, 200);
  assert.equal(send.body.data.sent, false);
  assert.equal(h.requests.length, 0);
});

test('AC-009: test-only identities cannot trigger real paid SMS sends', async () => {
  const h = harness();
  h.setTestAccount(true);
  const result = await h.call('user.member.phone.send', { phone: join.phone });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, 'PHONE_VERIFY_NOT_ALLOWED');
  assert.equal(h.requests.length, 0);
});

test('AC-010: disabled flag retains legacy join without performing Twilio calls', async () => {
  const h = harness({ required: false });
  assert.equal((await h.call('user.member.bootstrap')).body.data.phoneVerificationRequired, false);
  const result = await h.call('user.member.profile.save', join);
  assert.equal(result.status, 200);
  assert.equal(h.requests.length, 0);
});

test('AC-011: old generic API explicitly blocks unverified first-join route', () => {
  // Read the unmodified source: edge-test-fs rewrites businessEnv for the VM harness.
  const legacy = require('node:fs').readFileSync(path.join(__dirname, '../supabase/functions/api/index.ts'), 'utf8');
  assert.match(legacy, /PHONE_VERIFICATION_REQUIRED/);
  assert.match(legacy, /member\.membership_status !== "active"/);
  assert.match(legacy, /businessEnv\("TWILIO_VERIFY_REQUIRED"\)/);
});

test('AC-012: a verified phone is not sent another SMS and persists after bootstrap', async () => {
  const h = harness();
  assert.equal((await h.call('user.member.phone.send', { phone: join.phone })).status, 200);
  const joined = await h.call('user.member.profile.save', { ...join, otpCode: '123456' });
  assert.equal(joined.status, 200);
  assert.equal(h.member.phone_verified_e164, join.phone);
  assert.ok(h.member.phone_verified_at);
  const bootstrap = await h.call('user.member.bootstrap');
  assert.equal(bootstrap.body.data.profile.phoneVerified, true);
  const count = h.requests.length;
  const send = await h.call('user.member.phone.send', { phone: join.phone });
  assert.equal(send.status, 200);
  assert.equal(send.body.data.alreadyVerified, true);
  assert.equal(send.body.data.sent, false);
  assert.equal(h.requests.length, count);
});

test('AC-013: a changed phone requires fresh OTP and keeps the previous phone on failure', async () => {
  const h = harness();
  await h.call('user.member.profile.save', { ...join, otpCode: '123456' });
  const old = h.member.phone;
  const updatedPhone = '+886923456789';
  const noOtp = await h.call('user.member.profile.save', { phone: updatedPhone });
  assert.equal(noOtp.status, 400);
  assert.equal(noOtp.body.error.code, 'PHONE_OTP_REQUIRED');
  assert.equal(h.member.phone, old);
  const bad = await h.call('user.member.profile.save', { phone: updatedPhone, otpCode: '987654' });
  assert.equal(bad.status, 400);
  assert.equal(h.member.phone, old);
  const send = await h.call('user.member.phone.send', { phone: updatedPhone });
  assert.equal(send.status, 200);
  const saved = await h.call('user.member.profile.save', { phone: updatedPhone, otpCode: '123456' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.profile.phoneVerified, true);
  assert.equal(h.member.phone, updatedPhone);
  assert.equal(h.member.phone_verified_e164, updatedPhone);
});

test('AC-014: a phone already verified for another member is refused before SMS', async () => {
  const h = harness();
  h.setClaimedPhone(join.phone);
  const send = await h.call('user.member.phone.send', { phone: join.phone });
  assert.equal(send.status, 409);
  assert.equal(send.body.error.code, 'PHONE_ALREADY_USED');
  assert.equal(h.requests.length, 0);
  const before = { ...h.member };
  h.setCommitConflict(true);
  const save = await h.call('user.member.profile.save', { ...join, otpCode: '123456' });
  assert.equal(save.status, 409);
  assert.equal(save.body.error.code, 'PHONE_ALREADY_USED');
  assert.equal(h.member.membership_status, before.membership_status);
  assert.equal(h.member.phone, before.phone);
  assert.equal(h.member.phone_verified_e164, before.phone_verified_e164);
  assert.equal(h.member.phone_verified_at, before.phone_verified_at);
});

test('AC-015: unchanged active phone skips OTP, but the changed phone cannot mix profile fields', async () => {
  const h = harness();
  await h.call('user.member.profile.save', { ...join, otpCode: '123456' });
  const count = h.requests.length;
  const same = await h.call('user.member.profile.save', { phone: join.phone });
  assert.equal(same.status, 200);
  assert.equal(h.requests.length, count);
  const mixed = await h.call('user.member.profile.save', {
    phone: '+886923456789', surname: '許', otpCode: '123456',
  });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.error.code, 'PHONE_CHANGE_SEPARATE');
  assert.equal(h.member.phone, join.phone);
});

test('AC-016: disabled gate preserves existing profile-edit rollback without SMS', async () => {
  const h = harness({ required: false });
  await h.call('user.member.profile.save', join);
  const updated = await h.call('user.member.profile.save', { phone: '+886923456789' });
  assert.equal(updated.status, 200);
  assert.equal(h.member.phone, '+886923456789');
  assert.equal(h.requests.length, 0);
});


for (const region of ['us1', 'eu1']) {
  test(`Bird AC-001: normalized SMS uses the ${region} HTTPS host and bearer authentication`, async () => {
    const h = harness({ provider: 'bird', env: { BIRD_API_KEY: `bk_${region}_fixture-not-a-real-key` } });
    const result = await h.call('user.member.phone.send', { phone: '0912345678' });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.sent, true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].address, `https://${region}.platform.bird.com/v1/verify/verifications`);
    assert.deepEqual(h.requests[0].payload, { to: { phone_number: join.phone } });
    assert.equal(h.requests[0].method, 'POST');
    assert.equal(h.requests[0].authorization, `Bearer bk_${region}_fixture-not-a-real-key`);
    assert.ok(h.requests[0].timeout);
    assert.doesNotMatch(JSON.stringify(result.body), /bk_|fixture-not-a-real-key|123456/);
    assert.equal(h.member.membership_status, 'pending');
  });
}

test('Bird AC-002/003: only successful check activates and persists verified binding', async () => {
  const h = harness({ provider: 'bird' });
  const before = { ...h.member };
  const wrong = await h.call('user.member.profile.save', { ...join, otpCode: '654321' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'PHONE_OTP_INVALID');
  assert.equal(h.member.membership_status, before.membership_status);
  assert.equal(h.member.phone_verified_at, before.phone_verified_at);
  const result = await h.call('user.member.profile.save', { ...join, otpCode: '123456' });
  assert.equal(result.status, 200);
  assert.equal(h.member.membership_status, 'active');
  assert.equal(h.member.phone_verified_e164, join.phone);
  assert.ok(h.member.phone_verified_at);
  const check = h.requests.at(-1);
  assert.equal(check.address, 'https://us1.platform.bird.com/v1/verify/verifications/check');
  assert.deepEqual(check.payload, { to: { phone_number: join.phone }, code: '123456' });
  const count = h.requests.length;
  const resend = await h.call('user.member.phone.send', { phone: join.phone });
  assert.equal(resend.body.data.alreadyVerified, true);
  assert.equal(h.requests.length, count);
});

for (const scenario of [
  { name: 'expired', remoteBody: { success: false, reason: 'expired' }, status: 400, code: 'PHONE_OTP_EXPIRED' },
  { name: 'attempts exhausted', remoteBody: { success: false, reason: 'attempts_exhausted' }, status: 400, code: 'PHONE_OTP_INVALID' },
  { name: 'non-boolean success', remoteBody: { success: 'true' }, status: 400, code: 'PHONE_OTP_INVALID' },
  { name: 'untrusted status only', remoteBody: { status: 'verified' }, status: 400, code: 'PHONE_OTP_INVALID' },
  { name: 'already consumed or absent', remoteStatus: 404, status: 400, code: 'PHONE_OTP_EXPIRED' },
  { name: 'rate limit', remoteStatus: 429, status: 429, code: 'PHONE_VERIFY_RATE_LIMITED' },
  { name: 'unauthorized', remoteStatus: 401, status: 503, code: 'PHONE_VERIFY_UNAVAILABLE' },
  { name: 'forbidden', remoteStatus: 403, status: 503, code: 'PHONE_VERIFY_UNAVAILABLE' },
  { name: 'upstream failure', remoteStatus: 500, status: 503, code: 'PHONE_VERIFY_UNAVAILABLE' },
  { name: 'bad JSON', rawResponse: '{', status: 503, code: 'PHONE_VERIFY_UNAVAILABLE' },
  { name: 'network timeout', networkError: true, status: 503, code: 'PHONE_VERIFY_UNAVAILABLE' },
]) {
  test(`Bird AC-002: ${scenario.name} leaves existing phone and verification unchanged`, async () => {
    const h = harness({ provider: 'bird', ...scenario });
    Object.assign(h.member, { membership_status: 'active', phone: join.phone, phone_verified_e164: join.phone, phone_verified_at: '2026-11-01T00:00:00Z' });
    const result = await h.call('user.member.profile.save', { phone: '+886923456789', otpCode: '123456' });
    assert.equal(result.status, scenario.status);
    assert.equal(result.body.error.code, scenario.code);
    assert.equal(h.member.phone, join.phone);
    assert.equal(h.member.phone_verified_e164, join.phone);
    assert.equal(h.member.phone_verified_at, '2026-11-01T00:00:00Z');
    assert.equal(h.requests.length, 1, 'never retries a consume-once check');
    assert.doesNotMatch(JSON.stringify(result.body), /fixture-upstream-secret|123456|bk_/);
  });
}

for (const config of [
  { PHONE_VERIFY_PROVIDER: 'unknown' },
  { BIRD_API_KEY: '' },
  { BIRD_API_KEY: 'bk_invalid_fixture' },
  { BIRD_API_KEY: 'https://attacker.invalid' },
]) {
  test(`Bird AC-005: invalid server configuration ${Object.keys(config).join()} fails closed`, async () => {
    const h = harness({ provider: 'bird', env: config });
    const result = await h.call('user.member.phone.send', { phone: join.phone });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'PHONE_VERIFY_UNAVAILABLE');
    assert.equal(h.requests.length, 0, 'no fallback to another provider');
  });
}

test('Bird AC-003: same-tenant duplicate phone and transactional conflict stay rejected', async () => {
  const h = harness({ provider: 'bird' });
  h.setClaimedPhone(join.phone);
  assert.equal((await h.call('user.member.phone.send', { phone: join.phone })).status, 409);
  assert.equal(h.requests.length, 0);
  h.setCommitConflict(true);
  const result = await h.call('user.member.profile.save', { ...join, otpCode: '123456' });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'PHONE_ALREADY_USED');
  assert.equal(h.member.membership_status, 'pending');
  assert.equal(h.member.phone_verified_e164, null);
});

test('Bird AC-001/005: default country, synthetic identity and local rate guards precede paid calls', async () => {
  const h = harness({ provider: 'bird' });
  assert.equal((await h.call('user.member.phone.send', { phone: '+14155552671' })).body.error.code, 'PHONE_COUNTRY_UNAVAILABLE');
  assert.equal((await h.call('user.member.phone.send', { phone: '+886223456789' })).body.error.code, 'PHONE_MOBILE_REQUIRED');
  h.setTestAccount(true);
  assert.equal((await h.call('user.member.phone.send', { phone: join.phone })).status, 403);
  h.setTestAccount(false);
  h.setRateLimit(false);
  assert.equal((await h.call('user.member.phone.send', { phone: join.phone })).status, 429);
  assert.equal(h.requests.length, 0);
});

test('Bird AC-004: provider-neutral requirement overrides legacy flag in profile and legacy API', async () => {
  const h = harness({ required: true, env: { PHONE_VERIFY_REQUIRED: 'false' } });
  assert.equal((await h.call('user.member.bootstrap')).body.data.phoneVerificationRequired, false);
  assert.equal((await h.call('user.member.profile.save', join)).status, 200);
  assert.equal(h.requests.length, 0);
  const legacy = require('node:fs').readFileSync(path.join(__dirname, '../supabase/functions/api/index.ts'), 'utf8');
  assert.match(legacy, /businessEnv\("PHONE_VERIFY_REQUIRED"\)/);
});


test('Bird AC-004: legacy enrollment and changed-phone writes reject the new required flag', async () => {
  const legacy = fs.readFileSync(path.join(__dirname, '../supabase/functions/api/index.ts'), 'utf8')
    .replace(/^import .*\n/gm, '').replace(/^export default .*$/m, '');
  for (const flags of [{ PHONE_VERIFY_REQUIRED: 'true', TWILIO_VERIFY_REQUIRED: 'false' }, { PHONE_VERIFY_REQUIRED: '   ', TWILIO_VERIFY_REQUIRED: 'true' }]) {
  for (const membership of ['pending', 'active']) {
    let writes = 0;
    const context = vm.createContext({
      Deno: { env: { get: name => flags[name] || '' } },
      fixtureMember: { id: 'fixture', membership_status: membership, phone: join.phone },
    });
    vm.runInContext(stripTypeScriptTypes(legacy) + '\nensureMember = async () => fixtureMember;', context);
    const db = { rpc() { writes++; throw new Error('unexpected profile write'); } };
    await assert.rejects(
      context.handleAction(db, { lineUserId: 'fixture' }, 'user.member.profile.save', { ...join, phone: '+886923456789' }),
      error => error.status === 403 && error.code === 'PHONE_VERIFICATION_REQUIRED',
    );
    assert.equal(writes, 0);
  }
  }
});

test('Bird AC-001: server country allowlist can explicitly enable an international destination', async () => {
  const h = harness({ provider: 'bird', env: { PHONE_VERIFY_ALLOWED_COUNTRY_CODES: '+886,+1' } });
  const result = await h.call('user.member.phone.send', { phone: '+14155552671' });
  assert.equal(result.status, 200);
  assert.equal(h.requests[0].payload.to.phone_number, '+14155552671');
});

for (const remoteBody of [{ status: 'failed' }, { status: 'blocked' }, [], null]) {
  test(`Bird AC-002: unsuccessful or malformed send ${JSON.stringify(remoteBody)} cannot claim SMS sent`, async () => {
    const h = harness({ provider: 'bird', rawResponse: JSON.stringify(remoteBody) });
    const result = await h.call('user.member.phone.send', { phone: join.phone });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'PHONE_VERIFY_UNAVAILABLE');
    assert.equal(h.member.membership_status, 'pending');
    assert.equal(h.requests.length, 1, 'paid send never retries');
  });
}

test('Bird production: required enrollment works with every Twilio environment variable absent', async () => {
  const env = Object.fromEntries([
    'TWILIO_VERIFY_SERVICE_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET',
    'TWILIO_VERIFY_REQUIRED', 'TWILIO_VERIFY_ALLOWED_COUNTRY_CODES',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  ].map(name => [name, '']));
  const h = harness({ provider: 'bird', env });
  const bootstrap = await h.call('user.member.bootstrap');
  assert.equal(bootstrap.body.data.phoneVerificationRequired, true);
  const sent = await h.call('user.member.phone.send', { phone: join.phone });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.data.sent, true);
  const saved = await h.call('user.member.profile.save', { ...join, otpCode: '123456' });
  assert.equal(saved.status, 200);
  assert.equal(h.member.membership_status, 'active');
  assert.equal(h.member.phone_verified_e164, join.phone);
  assert.ok(h.member.phone_verified_at);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(request => request.address.startsWith('https://us1.platform.bird.com/')));
});
