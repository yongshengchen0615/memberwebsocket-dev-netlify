const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const sharedAuthFunctions = [
  'api',
  'grant-automation',
  'booking-api',
  'booking-calendar-api',
  'booking-admin-api',
  'event-ticket-links',
  'booking-admin-operations',
  'booking-cancellation-api',
  'member-profile-api',
  'pointcard-extension-api',
  'booking-group-api',
  'booking-group-details-api',
  'booking-group-slots-api',
  'test-mode-api',
  'test-control-api',
];

test('deployed shared-auth function set stays source-controlled', () => {
  for (const slug of sharedAuthFunctions) {
    const source = read(`supabase/functions/${slug}/index.ts`);
    assert.match(source, /_shared\/auth-contract\.ts/, slug);
    assert.match(source, /verifyLineIdTokenContract/, slug);
  }
});

test('shared LINE identity contract validates issuer, audience, issue time and expiry', () => {
  const source = read('supabase/functions/_shared/auth-contract.ts');
  const guard = read('supabase/functions/_shared/line-id-claims.mjs');
  assert.match(source, /isVerifiedLineIdClaim\(payload, expectedChannelId\)/);
  assert.match(guard, /aud === expectedChannelId/);
  assert.match(guard, /iss === 'https:\/\/access\.line\.me'/);
  assert.match(guard, /exp > nowSeconds && exp > iat/);
  assert.match(guard, /iat > 0 && iat <= nowSeconds \+ 60/);
  assert.match(guard, /\^U\[0-9a-f\]\{32\}\$/);
  assert.match(source, /requireActiveAdminContract/);
});

test('client-visible admin authorization errors do not echo LINE identity PII', () => {
  const source = read('supabase/functions/_shared/auth-contract.ts');
  const pending = source.slice(source.indexOf('if (admin.role !== "admin"'), source.indexOf('if (identity.displayName'));
  assert.match(pending, /ADMIN_PENDING/);
  assert.doesNotMatch(pending, /lineUserId|identity\.lineUserId/);
});
