const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helper = import('../supabase/functions/_shared/admin-rate-budget.mjs');
const normal = Object.freeze({
  p_principal_hash: 'a'.repeat(64),
  p_is_write: false,
  p_cost: 1,
  p_read_limit: 90,
  p_write_limit: 30,
});
const verifiedAdmin = 'U' + 'b'.repeat(32);

test('AC-RL-001: a verified admin read can pass the observed 105/min dashboard demand', async () => {
  const { adminReadRateLimitParams, ADMIN_READ_REQUESTS_PER_MINUTE } = await helper;
  const changed = adminReadRateLimitParams('consume_api_rate_limit', normal, verifiedAdmin);
  assert.equal(ADMIN_READ_REQUESTS_PER_MINUTE, 180);
  assert.deepEqual(changed, { ...normal, p_read_limit: 180 });
  assert.deepEqual(normal, { p_principal_hash: 'a'.repeat(64), p_is_write: false, p_cost: 1, p_read_limit: 90, p_write_limit: 30 });
  assert.notStrictEqual(changed, normal, 'do not mutate the original shared RPC parameters');
});

test('AC-RL-002: verified admin writes stay at 30/min and retain principal identity', async () => {
  const { adminReadRateLimitParams } = await helper;
  const write = { ...normal, p_is_write: true };
  assert.strictEqual(adminReadRateLimitParams('consume_api_rate_limit', write, verifiedAdmin), write);
  assert.equal(write.p_write_limit, 30);
  assert.equal(write.p_principal_hash, normal.p_principal_hash);
});

test('AC-RL-003: members and unverified callers retain the original 90/min read ceiling', async () => {
  const { adminReadRateLimitParams } = await helper;
  for (const forged of [null, undefined, '', 'member', 'Uinvalid']) {
    assert.strictEqual(adminReadRateLimitParams('consume_api_rate_limit', normal, forged), normal);
  }
  assert.equal(normal.p_read_limit, 90);
});

test('AC-RL-004: unrelated RPCs and invalid settings never gain read quota', async () => {
  const { adminReadRateLimitParams } = await helper;
  assert.strictEqual(adminReadRateLimitParams('admin_set_role', normal, verifiedAdmin), normal);
  for (const limit of [null, 0, -1, 1.5, '90', Infinity]) {
    const input = { ...normal, p_read_limit: limit };
    assert.strictEqual(adminReadRateLimitParams('consume_api_rate_limit', input, verifiedAdmin), input);
  }
  const generous = { ...normal, p_read_limit: 200 };
  assert.strictEqual(adminReadRateLimitParams('consume_api_rate_limit', generous, verifiedAdmin).p_read_limit, 200);
});

test('AC-RL-005: only the server-verified admin context can drive quota elevation', () => {
  const runtime = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/_shared/business-runtime.ts'), 'utf8');
  assert.match(runtime, /import\s*\{\s*adminReadRateLimitParams\s*\}\s*from\s*['"]\.\/admin-rate-budget\.mjs['"]/);
  assert.match(runtime, /adminReadRateLimitParams\(name,\s*forwarded\s*\|\|\s*params,\s*current\.verifiedAdmin\?\.actor\)/);
  assert.match(runtime, /if\(admin\)await assertBusinessAdmin\(c,body\)/);
  assert.doesNotMatch(runtime, /adminReadRateLimitParams\([^\n]*body\./, 'client JSON is never accepted as an admin authority');
});
