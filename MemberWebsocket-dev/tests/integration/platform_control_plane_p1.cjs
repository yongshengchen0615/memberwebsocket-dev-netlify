'use strict';
// AC-P1-001,002,004,006: isolated PGlite schema/privilege/constraint tests.
// DOES NOT access live Supabase, create a project, or grant a production root.
// PGlite is a single in-memory Postgres engine: NOT a real multi-connection
// concurrency, disaster-recovery, external LINE or Management API test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const file = path.resolve(__dirname, '../../supabase/plans/p1_control_plane_schema_sandbox_ONLY.sql');
const schema = fs.readFileSync(file, 'utf8');
const flags = Object.fromEntries(
  ['membership','points','events','calendar','integrations','booking','testing','usage']
    .map(name => [name, false])
);
const u = number => 'U' + number.repeat(32);

async function sandbox() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(schema);
  return db;
}
async function tenant(db, id='10000000-0000-4000-8000-000000000001', slug='merchant-a') {
  await db.query(
    'insert into platform_private.tenants(id,name,slug,owner_line_user_id,features,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$6)',
    [id,'Synthetic merchant',slug,u('1'),flags,'test-fixture']
  );
  return id;
}
async function setRole(db, role, action) {
  // RESET always runs even after a deliberate permission failure.
  await db.exec('set role ' + role);
  try { await action(); } finally { await db.exec('reset role'); }
}
test('AC-P1-001: fresh sandbox schema has nine private tables, RLS and zero root accounts', async () => {
  const db = await sandbox();
  try {
    const q = await db.query("select count(*)::int n from information_schema.tables where table_schema='platform_private' and table_type='BASE TABLE'");
    assert.equal(q.rows[0].n, 9);
    const rls = await db.query("select count(*)::int n from pg_tables where schemaname='platform_private' and rowsecurity");
    assert.equal(rls.rows[0].n, 9);
    assert.equal((await db.query('select count(*)::int n from platform_private.platform_operators')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,0);
    const defaults = await db.query("select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='platform_private' and p.prosecdef");
    assert.equal(defaults.rows[0].n,0);
  } finally { await db.close(); }
});
test('AC-P1-002: unauthorized roles cannot reach platform tables or authority functions', async () => {
  const db = await sandbox();
  try {
    for (const role of ['anon','authenticated']) {
      await setRole(db,role,async () => {
        await assert.rejects(db.query('select * from platform_private.tenants'),/permission denied/i);
        await assert.rejects(db.query('select * from platform_private.platform_operators'),/permission denied/i);
        await assert.rejects(db.query('select platform_private.features_valid($1::jsonb)',[flags]),/permission denied/i);
      });
    }
    await setRole(db,'service_role',async () => {
      assert.equal((await db.query('select count(*)::int n from platform_private.platform_operators')).rows[0].n,0);
      await assert.rejects(db.query('insert into platform_private.platform_operators(line_user_id,role) values ($1,$2)',[u('2'),'super_admin']),/permission denied/i);
      await assert.rejects(db.query('update platform_private.platform_operators set enabled=true'),/permission denied/i);
      await assert.rejects(db.query('delete from platform_private.platform_operators'),/permission denied/i);
      await assert.rejects(db.query('update platform_private.audit_events set action=$1',['tampered']),/permission denied/i);
      await assert.rejects(db.query('delete from platform_private.audit_events'),/permission denied/i);
    });
  } finally { await db.close(); }
});
test('AC-P1-001: exact eight boolean feature contract, unique slug and identity', async () => {
  const db = await sandbox();
  try {
    const id = await tenant(db);
    assert.ok(id);
    await assert.rejects(db.query(
      'insert into platform_private.tenants(name,slug,owner_line_user_id,features,created_by,updated_by) values ($1,$2,$3,$4,$5,$5)',
      ['duplicate','merchant-a',u('3'),flags,'fixture']
    ),/unique/i);
    for (const invalid of [{membership:true}, {...flags,membership:'true'}, {...flags,extra:true}]) {
      await assert.rejects(db.query(
        'update platform_private.tenants set features=$1 where id=$2',
        [invalid,id]
      ),/check constraint|violates/i);
    }
    await assert.rejects(db.query(
      "insert into platform_private.platform_operators(line_user_id,role,enabled) values ($1,'super_admin',true)",
      [u('4')]
    ),/check constraint|violates/i);
    assert.equal((await db.query('select count(*)::int n from platform_private.platform_operators')).rows[0].n,0);
  } finally { await db.close(); }
});
test('AC-P1-006: environment evidence and LINE readiness required before activation', async () => {
  const db = await sandbox();
  try {
    const id = await tenant(db);
    await assert.rejects(db.query("update platform_private.tenants set status='active' where id=$1",[id]),/check constraint|TENANT_NOT_PROVISIONED/i);
    await db.query("insert into platform_private.tenant_environments(tenant_id,region) values ($1,'ap-northeast-1')",[id]);
    await assert.rejects(db.query("update platform_private.tenant_environments set stage='verified' where tenant_id=$1",[id]),/check constraint|violates/i);
    await db.query("update platform_private.tenant_environments set project_ref=$1,stage='verified',schema_version='v1',verified_at=now(),health_checked_at=now() where tenant_id=$2",['a'.repeat(20),id]);
    await assert.rejects(db.query("update platform_private.tenants set status='active' where id=$1",[id]),/TENANT_NOT_PROVISIONED|check constraint/i);
    await db.query("update platform_private.tenants set credentials_configured=true,isolation_verified_at=now(),isolation_version='v1',status='active' where id=$1",[id]);
    assert.equal((await db.query('select status from platform_private.tenants where id=$1',[id])).rows[0].status,'active');
    await assert.rejects(db.query("update platform_private.tenant_environments set stage='quarantined' where tenant_id=$1",[id]),/SUSPEND_ACTIVE_TENANT_FIRST/i);
    await assert.rejects(db.query("update platform_private.tenant_environments set project_ref=$1 where tenant_id=$2",['b'.repeat(20),id]),/SUSPEND_ACTIVE_TENANT_FIRST/i);
    await assert.rejects(db.query("update platform_private.tenant_environments set schema_version='v2' where tenant_id=$1",[id]),/SUSPEND_ACTIVE_TENANT_FIRST/i);
    await db.query("update platform_private.tenants set status='suspended' where id=$1",[id]);
    await db.query("update platform_private.tenant_environments set stage='quarantined' where tenant_id=$1",[id]);
    assert.equal((await db.query('select stage from platform_private.tenant_environments where tenant_id=$1',[id])).rows[0].stage,'quarantined');
  } finally { await db.close(); }
});
test('AC-P1-004: duplicate project refs and request/job IDs cannot be persisted', async () => {
  const db = await sandbox();
  try {
    const a=await tenant(db);
    const b=await tenant(db,'20000000-0000-4000-8000-000000000002','merchant-b');
    const ref='a'.repeat(20);
    await db.query("insert into platform_private.tenant_environments(tenant_id,region,project_ref) values ($1,'ap-northeast-1',$2)",[a,ref]);
    await assert.rejects(db.query("insert into platform_private.tenant_environments(tenant_id,region,project_ref) values ($1,'ap-northeast-1',$2)",[b,ref]),/unique/i);
    const reqId='30000000-0000-4000-8000-000000000003';
    await db.query("insert into platform_private.provisioning_jobs(tenant_id,idempotency_key,operation) values ($1,$2,'create_project')",[a,reqId]);
    await assert.rejects(db.query("insert into platform_private.provisioning_jobs(tenant_id,idempotency_key,operation) values ($1,$2,'create_project')",[a,reqId]),/unique/i);
    await db.query("insert into platform_private.requests(request_id,actor,operation,payload_hash,result) values ($1,'synthetic','approve',$2,$3)",[reqId,'f'.repeat(64),{success:true}]);
    await assert.rejects(db.query("insert into platform_private.requests(request_id,actor,operation,payload_hash,result) values ($1,'synthetic','approve',$2,$3)",[reqId,'a'.repeat(64),{success:false}]),/unique/i);
    assert.equal((await db.query('select count(*)::int n from platform_private.provisioning_jobs')).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from platform_private.requests')).rows[0].n,1);
  } finally { await db.close(); }
});
