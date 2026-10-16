const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = fs.readFileSync(
  path.join(__dirname, '../../supabase/migrations/20261008075553_single_active_member_login.sql'),
  'utf8',
);
const hash = char => char.repeat(64);
const query = (db, sql, args = []) => db.query(sql, args);
const claim = (db, browser, token, issued, mode = 'login') =>
  query(db, 'select public.member_login_claim($1,$2,$3,$4,$5) as state',
    ['QA_SINGLE_LOGIN', hash(browser), hash(token), issued, mode]).then(v => v.rows[0].state);
const logout = (db, token) => query(db,
  'select public.member_login_logout($1,$2) as revoked',
  ['QA_SINGLE_LOGIN', hash(token)]).then(v => v.rows[0].revoked);

test('single-login migration serializes account takeover and keeps the newest token only', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(migration);
    assert.equal(await claim(db, 'a', '1', 100000), 'claimed');
    assert.equal(await claim(db, 'a', '2', 100001, 'resume'), 'resumed');
    assert.equal(await claim(db, 'b', '3', 100002, 'resume'), 'session_replaced');
    assert.equal(await claim(db, 'b', '3', 99999), 'session_replaced');
    assert.equal(await claim(db, 'b', '3', 100001), 'session_replaced',
      'an equal-second stale token cannot retake the session');
    assert.equal(await claim(db, 'b', '3', 100003), 'replaced');
    const grant = await query(db,
      'select token_hash from public.member_login_token_grants where line_user_id=$1',
      ['QA_SINGLE_LOGIN']);
    assert.deepEqual(grant.rows, [{ token_hash: hash('3') }]);
    assert.equal(await logout(db, '1'), false, 'old browser logout must not revoke B');
    assert.equal(await logout(db, '3'), true);
    assert.equal(await logout(db, '3'), false, 'logout is idempotent');
    const after = await query(db,'select count(*)::int as count from public.member_login_token_grants');
    assert.equal(after.rows[0].count, 0);
    assert.equal(await claim(db, 'c', '4', 100004), 'replaced',
      'a fresh login may recover after explicit logout');
    for (const role of ['anon', 'authenticated']) {
      await db.exec('set role ' + role);
      await assert.rejects(query(db, 'select * from public.member_login_sessions'), /permission denied/);
      await assert.rejects(claim(db, 'd', '5', 100005), /permission denied/);
      await db.exec('reset role');
    }
  } finally { await db.close(); }
});
