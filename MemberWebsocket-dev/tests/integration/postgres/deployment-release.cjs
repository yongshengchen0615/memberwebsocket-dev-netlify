const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const database = require('./database.cjs');
let release;
test.before(async () => { release = await import('../../../../scripts/supabase-release.mjs'); });
const sha = 'b'.repeat(40);
const migration = (version, sql) => ({ version, filename: version + '_synthetic.sql', sql,
  checksum: createHash('sha256').update(sql).digest('hex') });
async function fixture(t) {
  const { db } = await database();
  t.after(() => db.close());
  await db.exec('CREATE TABLE public.members(id int PRIMARY KEY, marker text); INSERT INTO public.members VALUES (1,\'preserved\'); CREATE SCHEMA platform_private; CREATE TABLE platform_private.super_admins(id int);');
  return db;
}
test('AC-003 fresh deployment and upgrade apply once and protect the private ledger', async t => {
  const db = await fixture(t);
  const first = migration('20261116000100', 'CREATE TABLE public.release_fixture(id int PRIMARY KEY); INSERT INTO public.release_fixture VALUES (1);');
  const second = migration('20261116000200', "ALTER TABLE public.release_fixture ADD COLUMN note text NOT NULL DEFAULT 'upgraded';");
  await db.exec(release.migrationSQL({ migrations: [first] }, sha));
  await db.exec(release.migrationSQL({ migrations: [first, second] }, sha));
  await db.exec(release.migrationSQL({ migrations: [first, second] }, sha));
  assert.deepEqual((await db.query('SELECT * FROM public.release_fixture')).rows, [{ id: 1, note: 'upgraded' }]);
  assert.equal((await db.query('SELECT count(*)::int n FROM deployment_private.schema_releases')).rows[0].n, 2);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await db.exec('SET ROLE ' + role);
    await assert.rejects(db.query('SELECT * FROM deployment_private.schema_releases'), /permission denied/);
    await db.exec('RESET ROLE');
  }
  assert.deepEqual((await db.query('SELECT * FROM public.members')).rows, [{ id: 1, marker: 'preserved' }]);
});
test('AC-004 migration failure rolls back schema, ledger and writes; corrected batch can recover', async t => {
  const db = await fixture(t);
  const first = migration('20261116000100', "CREATE TABLE public.release_fixture(id int); UPDATE public.members SET marker='changed';");
  const broken = migration('20261116000200', 'SELECT missing_column FROM public.members;');
  await assert.rejects(db.exec(release.migrationSQL({ migrations: [first, broken] }, sha)), /missing_column/);
  // A failed PostgreSQL simple-query transaction must be explicitly rolled back
  // before reusing this client. The remote release request is not retried.
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT to_regclass('public.release_fixture')::text name")).rows[0].name, null);
  assert.equal((await db.query("SELECT to_regnamespace('deployment_private')::text name")).rows[0].name, null);
  assert.equal((await db.query('SELECT marker FROM public.members')).rows[0].marker, 'preserved');
  await db.exec(release.migrationSQL({ migrations: [first] }, sha));
  assert.equal((await db.query('SELECT count(*)::int n FROM deployment_private.schema_releases')).rows[0].n, 1);
  const backup = await db.backupRestore();
  assert.equal((await backup.client.query('SELECT count(*)::int n FROM deployment_private.schema_releases')).rows[0].n, 1);
});
test('AC-005 changed, renamed, removed and backdated migrations fail without modifying existing data', async t => {
  const db = await fixture(t);
  const applied = migration('20261116000200', 'CREATE TABLE public.release_fixture(id int);');
  await db.exec(release.migrationSQL({ migrations: [applied] }, sha));
  for (const migrations of [
    [{ ...applied, checksum: 'c'.repeat(64) }],
    [{ ...applied, filename: '20261116000200_renamed.sql' }], [],
    [migration('20261116000100', 'SELECT 1;'), applied],
  ]) {
    await assert.rejects(db.exec(release.migrationSQL({ migrations }, sha)), /APPLIED_MIGRATION_DRIFT|OUT_OF_ORDER_MIGRATION/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int n FROM deployment_private.schema_releases')).rows[0].n, 1);
    assert.equal((await db.query('SELECT marker FROM public.members')).rows[0].marker, 'preserved');
  }
});
test('AC-005 concurrent first deployments commit the real DDL and its ledger exactly once', async t => {
  const db = await fixture(t);
  const other = await db.connect();
  const pending = migration('20261116000100', 'CREATE TABLE public.release_fixture(id int); INSERT INTO public.release_fixture VALUES (1); SELECT pg_sleep(0.1);');
  const sql = release.migrationSQL({ migrations: [pending] }, sha);
  await Promise.all([db.exec(sql), other.query(sql)]);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.release_fixture')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM deployment_private.schema_releases')).rows[0].n, 1);
});
