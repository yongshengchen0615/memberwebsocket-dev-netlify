const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const now = 1_800_000_000_000;
const channel = '2010791619';
const valid = {
  sub: 'U' + 'a'.repeat(32),
  aud: channel,
  iss: 'https://access.line.me',
  iat: now / 1000 - 10,
  exp: now / 1000 + 300,
};
const check = async (claims, time = now) => {
  const { isVerifiedLineIdClaim } = await import(pathToFileURL(path.join(__dirname, '../supabase/functions/_shared/line-id-claims.mjs')));
  return isVerifiedLineIdClaim(claims, channel, time);
};

test('valid provider-verified LINE claims are accepted within allowed clock skew', async () => {
  assert.equal(await check(valid), true);
  assert.equal(await check({ ...valid, iat: now / 1000 + 60 }), true);
});

test('wrong channel, issuer, identifier and malformed provider responses fail closed', async () => {
  for (const claims of [null, [], {}, 'text',
    { ...valid, aud: 'other' }, { ...valid, aud: [channel] },
    { ...valid, iss: 'https://example.test' },
    { ...valid, sub: 'attacker' }, { ...valid, sub: 123 },
    { ...valid, sub: 'U' + 'z'.repeat(32) },
  ]) assert.equal(await check(claims), false);
});

test('expired, future, negative, reversed and coerced timestamps fail closed', async () => {
  for (const patch of [
    { exp: now / 1000 }, { exp: '9999999999' },
    { exp: valid.iat }, { iat: now / 1000 + 61 },
    { iat: 0 }, { iat: -1 }, { iat: String(valid.iat) },
    { iat: Infinity }, { exp: NaN },
  ]) assert.equal(await check({ ...valid, ...patch }), false, JSON.stringify(patch));
});

test('active shared contract uses the verified-claims guard before database access', () => {
  const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/_shared/auth-contract.ts'), 'utf8');
  assert.match(source, /import\s*\{\s*isVerifiedLineIdClaim\s*\}\s*from\s*['"]\.\/line-id-claims\.mjs['"]/);
  assert.match(source, /if\s*\(!response\.ok\s*\|\|\s*!isVerifiedLineIdClaim\(payload,\s*expectedChannelId\)\)/);
  assert.match(source, /idToken\.length\s*>\s*10_000/);
  assert.match(source, /AbortSignal\.timeout\(15_000\)/);
});
