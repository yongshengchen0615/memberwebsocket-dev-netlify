const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261014030000_fix_point_balance_upsert_reservation_guard.sql'),
  'utf8'
);

test('UPSERT INSERT candidate is not mistaken for the resulting point balance', () => {
  assert.match(migration, /if tg_op = 'INSERT' then/);
  assert.match(migration, /if not exists \(/);
  assert.match(migration, /from public\.point_balances existing/);
  assert.match(migration, /existing\.member_id = new\.member_id/);
  assert.match(migration, /existing\.point_card_id = new\.point_card_id/);
  assert.match(migration, /raise exception 'INSUFFICIENT_POINTS'/);
});

test('real reductions below future booking reservations are still rejected', () => {
  assert.match(migration, /b\.status = 'pending'/);
  assert.match(migration, /pt\.point_card_id = new\.point_card_id/);
  assert.match(migration, /coalesce\(new\.stamps, 0\) < v_reserved_points/);
  assert.match(migration, /elsif coalesce\(new\.stamps, 0\) < coalesce\(old\.stamps, 0\) then/);
  assert.doesNotMatch(migration, /disable trigger|drop trigger|security definer/i);
});

test('UPSERT and real balance states use separate invariants', () => {
  const protectedReduction = (before, after, reserved) => after < reserved && after < before;
  const rejectedNewBalance = (incoming, reserved, exists) => incoming < reserved && !exists;
  // A 31-point balance, 5 reserved, and 5 redeemed leaves 26; a subsequent
  // two-point reward UPSERT has an INSERT candidate of 2, not a final 28.
  assert.equal(rejectedNewBalance(2, 5, true), false);
  assert.equal(protectedReduction(26, 28, 5), false);
  assert.equal(rejectedNewBalance(2, 5, false), true);
  assert.equal(protectedReduction(26, 4, 5), true);
  assert.equal(protectedReduction(4, 5, 6), false); // healing an old inconsistency
});
