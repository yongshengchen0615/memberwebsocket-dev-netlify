const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = import('../supabase/functions/_shared/api-rate-policy.mjs');
const principalHash = 'a'.repeat(64);
const base = Object.freeze({
  p_principal_hash: principalHash, p_is_write: true,
  p_cost: 1, p_read_limit: 90, p_write_limit: 30,
});
const decide = async (action, input = base, rpc = 'consume_api_rate_limit') =>
  (await policy).partitionRateLimitParams(rpc, input, action);

test('AC-RL-101: presence updates do not consume the regular write budget', async () => {
  const presence = await decide('user.booking.presence.heartbeat');
  const another = await decide('user.member.presence.online');
  assert.equal(presence.p_is_write, true);
  assert.equal(presence.p_write_limit, 120);
  assert.equal(presence.p_read_limit, 90);
  assert.equal(presence.p_principal_hash, another.p_principal_hash);
  assert.notEqual(presence.p_principal_hash, base.p_principal_hash);
  assert.match(presence.p_principal_hash, /^[a-f0-9]{64}$/);
  assert.equal(base.p_write_limit, 30);
});

test('AC-RL-102: status polling is isolated from ordinary reads and remains bounded', async () => {
  const read = { ...base, p_is_write: false };
  const poll = await decide('user.booking.sync.status', read);
  const admin = await decide('admin.sync.status', read);
  assert.equal(poll.p_read_limit, 180);
  assert.equal(poll.p_is_write, false);
  assert.equal(poll.p_principal_hash, admin.p_principal_hash);
  assert.notEqual(poll.p_principal_hash, read.p_principal_hash);
  assert.strictEqual(await decide('user.booking.bootstrap', read), read);
});

test('AC-RL-103: sensitive changes receive a separate lower limit', async () => {
  const remove = await decide('admin.member.remove');
  const grant = await decide('admin.member-grants.add');
  assert.equal(remove.p_write_limit, 12);
  assert.equal(remove.p_principal_hash, grant.p_principal_hash);
  assert.notEqual(remove.p_principal_hash, base.p_principal_hash);
  assert.strictEqual(await decide('admin.booking.status.update'), base);
  assert.equal((await decide('admin.member.remove', { ...base, p_write_limit: 8 })).p_write_limit, 8);
});

test('AC-RL-104: unknown or mismatched actions cannot acquire a relaxed quota', async () => {
  for (const action of [
    'user.booking.presence.hack', 'user.member.presence.heartbeat.extra',
    'unknown.sync.status', 'admin.member.remove.fake',
  ]) assert.strictEqual(await decide(action), base);
  assert.strictEqual(await decide('user.booking.sync.status'), base);
  const read = { ...base, p_is_write: false };
  assert.strictEqual(await decide('user.booking.presence.heartbeat', read), read);
  assert.strictEqual(await decide('admin.member.remove', read), read);
  assert.strictEqual(await decide('user.booking.presence.heartbeat', base, 'admin_set_role'), base);
});

test('AC-RL-105: costs and principal isolation are preserved', async () => {
  const expensive = { ...base, p_cost: 20 };
  const sensitive = await decide('admin.member.remove', expensive);
  assert.equal(sensitive.p_cost, 20);
  const other = { ...base, p_principal_hash: 'b'.repeat(64) };
  assert.notEqual((await decide('admin.member.remove', other)).p_principal_hash, sensitive.p_principal_hash);
  const malformed = { ...base, p_principal_hash: 'unverified' };
  assert.strictEqual(await decide('admin.member.remove', malformed), malformed);
});

test('AC-RL-106: invalid RPC inputs are left untouched', async () => {
  for (const invalid of [null, [], { ...base, p_cost: 0 }, { ...base, p_is_write: 'true' }, { ...base, p_write_limit: 0 }]) {
    assert.strictEqual(await decide('admin.member.remove', invalid), invalid);
  }
});

test('AC-RL-107: runtime applies policy after scope and authorization checks', () => {
  const runtime = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/_shared/business-runtime.ts'), 'utf8');
  assert.match(runtime, /import\s*\{\s*partitionRateLimitParams\s*\}\s*from\s*['"]\.\/api-rate-policy\.mjs['"]/);
  assert.match(runtime, /c\.rateAction\s*=\s*action/);
  assert.match(runtime, /assertBusinessRpc\(current,name,params,target\)/);
  assert.match(runtime, /await partitionRateLimitParams\(name,\s*budgeted,\s*current\.rateAction\)/);
});

test('AC-RL-108: existing administrator read budget is preserved', async () => {
  const verifiedAdminRead = { ...base, p_is_write: false, p_read_limit: 180 };
  assert.strictEqual(await decide('admin.bootstrap', verifiedAdminRead), verifiedAdminRead);
  const sync = await decide('admin.sync.status', verifiedAdminRead);
  assert.equal(sync.p_read_limit, 180);
  assert.equal(sync.p_write_limit, 30);
  assert.notEqual(sync.p_principal_hash, verifiedAdminRead.p_principal_hash);
});
