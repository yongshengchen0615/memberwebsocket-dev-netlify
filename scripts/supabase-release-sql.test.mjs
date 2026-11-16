import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { migrationSQL } from './supabase-release.mjs';
const require = createRequire(new URL('../MemberWebsocket-dev/tests/integration/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const sha = 'b'.repeat(40);
const migration = (version, sql) => ({ version, filename: version + '_synthetic.sql', sql, checksum: createHash('sha256').update(sql).digest('hex') });
async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE public.members(id int); INSERT INTO public.members VALUES (1); CREATE SCHEMA platform_private; CREATE TABLE platform_private.super_admins(id int);");
  return db;
}
test('AC-003 SQL executes real multi-statement DDL and does not repeat it', async t => {
  const db = await fixture(t);
  const migrations = [migration('20261116000100', 'CREATE TABLE public.release_fixture(id int); INSERT INTO public.release_fixture VALUES (1);')];
  await db.exec(migrationSQL({ migrations }, sha));
  await db.exec(migrationSQL({ migrations }, sha));
  assert.deepEqual((await db.query('SELECT * FROM public.release_fixture')).rows, [{ id: 1 }]);
  assert.equal((await db.query('SELECT count(*)::int n FROM deployment_private.schema_releases')).rows[0].n, 1);
});
test('AC-004 failure undoes earlier SQL and initial ledger creation', async t => {
  const db = await fixture(t);
  const migrations = [migration('20261116000100', 'CREATE TABLE public.release_fixture(id int); DELETE FROM public.members;'), migration('20261116000200', 'SELECT missing_column FROM public.members;')];
  await assert.rejects(db.exec(migrationSQL({ migrations }, sha)), /missing_column/);
  await db.exec('ROLLBACK');
  assert.equal((await db.query("SELECT to_regclass('public.release_fixture')::text name")).rows[0].name, null);
  assert.equal((await db.query('SELECT count(*)::int n FROM public.members')).rows[0].n, 1);
  assert.equal((await db.query("SELECT to_regnamespace('deployment_private')::text name")).rows[0].name, null);
});
test('AC-005 actual SQL refuses missing, changed, renamed and out-of-order migrations', async t => {
  const db = await fixture(t);
  const applied = migration('20261116000200', 'CREATE TABLE public.release_fixture(id int);');
  await db.exec(migrationSQL({ migrations: [applied] }, sha));
  for (const migrations of [[], [{ ...applied, checksum: 'c'.repeat(64) }], [{ ...applied, filename: '20261116000200_rename.sql' }], [migration('20261116000100', 'SELECT 1;'), applied]]) {
    await assert.rejects(db.exec(migrationSQL({ migrations }, sha)), /APPLIED_MIGRATION_DRIFT|OUT_OF_ORDER_MIGRATION/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int n FROM deployment_private.schema_releases')).rows[0].n, 1);
  }
});

test('AC-004 valid migration strings may contain both generated dollar-quote delimiters', async t => {
  const db = await fixture(t);
  const sql = "CREATE TABLE public.release_quote_fixture(v text); INSERT INTO public.release_quote_fixture VALUES ('$apply$'), ('$migration_20261116001000$'), ('$release_apply$');";
  await db.exec(migrationSQL({ migrations: [migration('20261116001000', sql)] }, sha));
  assert.deepEqual((await db.query('SELECT v FROM public.release_quote_fixture ORDER BY v')).rows,
    [{ v: '$apply$' }, { v: '$migration_20261116001000$' }, { v: '$release_apply$' }]);
});
