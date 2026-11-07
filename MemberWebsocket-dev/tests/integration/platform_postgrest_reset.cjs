const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = fs.readFileSync(path.resolve(__dirname,
  '../../supabase/migrations/20261024093000_reconcile_postgrest_after_sandbox_business_reset.sql'),'utf8');
const start = migration.indexOf('CREATE OR REPLACE FUNCTION maintenance.prune_orphaned_postgrest_business_schemas()');
const end = migration.indexOf('\nREVOKE ALL ON FUNCTION',start);
assert.ok(start > 0 && end > start, 'the committed helper DDL must be present');
const helper = migration.slice(start,end);
const configured = async db =>
  (await db.query("select unnest(rolconfig) as v from pg_roles where rolname='authenticator'")).rows
    .find(row => row.v.startsWith('pgrst.db_schemas='))?.v?.slice('pgrst.db_schemas='.length);
const prune = async db =>
  (await db.query('select maintenance.prune_orphaned_postgrest_business_schemas() as removed')).rows[0].removed;

async function isolated() {
  const db=new PGlite();
  await db.exec('create role authenticator; create role anon; create role authenticated; create role service_role; create schema maintenance;');
  await db.exec(helper);
  await db.exec('revoke all on function maintenance.prune_orphaned_postgrest_business_schemas() from public,anon,authenticated,service_role;');
  return db;
}

test('AC-106-001/002: prune missing business only; preserve active and non-business API schemas',async()=>{
 const db=await isolated();try{
  const existing='business_'+'a'.repeat(32),gone='business_'+'b'.repeat(32);
  await db.exec(`create schema ${existing}`);
  await db.exec(`alter role authenticator set pgrst.db_schemas = 'public,graphql_public,${existing},${gone},custom_api'`);
  assert.equal(await prune(db),1);
  assert.equal(await configured(db),`public,graphql_public,${existing},custom_api`);
  assert.equal(await prune(db),0,'repeated cleanup must be idempotent');
  assert.equal((await db.query('select count(*)::int as n from pg_namespace where nspname=$1',[existing])).rows[0].n,1);
 }finally{await db.close();}
});

test('AC-106-003/004: refuse non-DBA, and no explicit override means no configuration mutation',async()=>{
 const db=await isolated();try{
  assert.equal(await prune(db),0);
  assert.equal(await configured(db),undefined);
  await db.exec('set role service_role');
  try {await assert.rejects(prune(db),/permission denied|POSTGREST_SCHEMA_REPAIR_DBA_ONLY/)}
  finally{await db.exec('reset role')}
 }finally{await db.close();}
});

test('AC-106-005: role changes and config cleanup roll back together',async()=>{
 const db=await isolated();try{
  const missing='business_'+'c'.repeat(32);
  await db.exec("alter role authenticator set pgrst.db_schemas = 'public,graphql_public'");
  await db.exec('begin');
  await db.exec(`alter role authenticator set pgrst.db_schemas = 'public,graphql_public,${missing}'`);
  assert.equal(await prune(db),1);
  await db.exec('rollback');
  assert.equal(await configured(db),'public,graphql_public');
 }finally{await db.close();}
});

test('AC-106-006: reset hook is inserted after merchant cleanup without altering guards',()=>{
 assert.match(migration,/RESET_HOOK_DEFINITION_DRIFT/);
 assert.match(migration,/v_removed_schemas := v_removed_schemas\+1;.*?end loop;.*?prune_orphaned_postgrest_business_schemas\(\)/s);
 assert.match(migration,/pg_get_functiondef\(/);
 assert.doesNotMatch(migration,/\bgrant\s+execute\s+on\s+function\s+maintenance\.prune_orphaned_postgrest_business_schemas/i);
});
