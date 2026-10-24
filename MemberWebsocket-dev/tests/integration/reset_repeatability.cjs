const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {PGlite} = require('@electric-sql/pglite');

const migration = fs.readFileSync(path.join(__dirname,
  '../../supabase/migrations/20261024100000_repeatable_sql_editor_full_reset.sql'),'utf8');
const confirm = 'RESET MEMBERWEBSOCKET TEST DATA';
const person = 'U'+'a'.repeat(32);
const count = async(db, table) => Number((await db.query('select count(*)::int c from '+table)).rows[0].c);
const fingerprint = async db => (await db.query(
  "select maintenance.plan_sandbox_database_reset()->>'fingerprint' f")).rows[0].f;
const reset = async(db,id) => db.query(
  'select maintenance.execute_sandbox_database_reset($1,$2,$3) r',
  [id,await fingerprint(db),confirm]);

async function fixture(){
 const db=new PGlite();
 try {
  await db.exec([
   'create role anon; create role authenticated; create role service_role;',
   'create schema maintenance; create schema platform_private; create schema booking_notifications;',
   'create schema line_config; create schema auth; create schema storage;',
   'create schema cron; create schema extensions; create schema net;',
   'create table public.admins(id int primary key);',
   'create table public.members(id int primary key);',
   'create table public.system_settings(id int primary key);',
   'create table platform_private.super_admins(line_user_id text primary key, singleton boolean,enabled boolean,admin_id uuid);',
   'create table platform_private.tenants(id int primary key);',
   'create table platform_private.business_templates(id int primary key);',
   'create table line_config.settings(id int primary key);',
   'create table auth.users(id int primary key);',
   'create table storage.objects(id int primary key);',
   'create table cron.job(jobid bigint primary key,active boolean);',
   'create table maintenance.sandbox_reset_target(singleton boolean primary key,project_ref text,sandbox_approved boolean,backup_verified_at timestamptz,storage_restore_verified_at timestamptz,provider_isolation_verified_at timestamptz);',
   'create table maintenance.sandbox_reset_epoch(singleton boolean primary key,last_completed_request uuid,last_completed_at timestamptz,root_bootstrap_required boolean,bootstrapped_at timestamptz);',
   "create table maintenance.sql_full_reset_jobs(id uuid primary key,ticket_sha256 text not null,fingerprint text not null,state text not null default 'queued',requested_at timestamptz default now(),started_at timestamptz,finished_at timestamptz,error_code text,pg_net_request_id bigint);",
   "insert into maintenance.sandbox_reset_target(singleton,project_ref,sandbox_approved) values(true,'dbuquirnaskrwcamdxki',true);",
   "insert into maintenance.sandbox_reset_epoch values(true,'11111111-1111-4111-8111-111111111111',now(),true,null);",
   "insert into platform_private.super_admins values('"+person+"',null,false,null);",
   "create function maintenance.plan_sandbox_database_reset() returns jsonb language sql stable as $$select jsonb_build_object('fingerprint',repeat('a',64),'plannedRows',1)$$;",
   "create function maintenance.prune_orphaned_postgrest_business_schemas() returns void language plpgsql as $$begin null;end$$;",
   "create function maintenance.ensure_required_system_baseline() returns void language plpgsql as $$begin null;end$$;",
   "create function maintenance.ensure_referral_reward_baseline() returns void language plpgsql as $$begin null;end$$;",
   "create function maintenance.ensure_event_ticket_settings_baseline() returns void language plpgsql as $$begin null;end$$;",
   "create function extensions.gen_random_bytes(n integer) returns bytea language sql as $$select decode(repeat('ab',n),'hex')$$;",
   "create function net.http_post(url text,body jsonb,params jsonb default '{}'::jsonb,headers jsonb default '{}'::jsonb,timeout_milliseconds integer default 2000) returns bigint language sql as $$select 42::bigint$$;"
  ].join('\n'));
  await db.exec(migration);
  return db;
 }catch(e){await db.close();throw e}
}

test('AC-CLR-050: a second full reset queues even while root bootstrap is pending',async()=>{
 const db=await fixture();
 try{
  assert.equal((await db.query('select root_bootstrap_required from maintenance.sandbox_reset_epoch')).rows[0].root_bootstrap_required,true);
  const queued=(await db.query('select maintenance.request_full_reset_from_sql($1) r',[confirm])).rows[0].r;
  assert.equal(queued.submitted,true);
  assert.equal(queued.completed,false);
  assert.equal(await count(db,'maintenance.sql_full_reset_jobs'),1);
  assert.equal(await count(db,'platform_private.super_admins'),1,
    'HTTP async queue must not directly wipe Platform candidate');
 }finally{await db.close()}
});
test('AC-CLR-051: repeated reset deletes pending Platform candidate and retains bootstrap-required epoch',async()=>{
 const db=await fixture();
 try {
  const id='22222222-2222-4222-8222-222222222222';
  const result=(await reset(db,id)).rows[0].r;
  assert.equal(result.databaseReset,true);
  assert.equal(await count(db,'platform_private.super_admins'),0);
  assert.equal((await db.query('select root_bootstrap_required from maintenance.sandbox_reset_epoch')).rows[0].root_bootstrap_required,true);
  assert.equal((await db.query('select last_completed_request from maintenance.sandbox_reset_epoch')).rows[0].last_completed_request,id);
  await db.query('insert into platform_private.super_admins values($1,null,false,null)',[person]);
  const next=(await reset(db,'33333333-3333-4333-8333-333333333333')).rows[0].r;
  assert.equal(next.databaseReset,true);
  assert.equal(await count(db,'platform_private.super_admins'),0);
 }finally{await db.close()}
});
test('AC-CLR-052: never wipe application state before supported Auth/Storage deletion and cron pause',async()=>{
 const db=await fixture();
 try{
  await db.exec('insert into auth.users values(5);');
  await assert.rejects(reset(db,'44444444-4444-4444-8444-444444444444'),/RESET_AUTH_OR_STORAGE_API_CLEANUP_PENDING/);
  assert.equal(await count(db,'platform_private.super_admins'),1);
  await db.exec('delete from auth.users; insert into cron.job values(9,true);');
  await assert.rejects(reset(db,'44444444-4444-4444-8444-444444444444'),/RESET_ACTIVE_CRON_JOBS_PRESENT/);
  assert.equal(await count(db,'platform_private.super_admins'),1);
 }finally{await db.close()}
});
test('AC-CLR-053: DBA confirmation, allowlist and role requirements remain strict',async()=>{
 const db=await fixture();
 try{
  await assert.rejects(db.query('select maintenance.request_full_reset_from_sql($1)',['bad']),/RESET_EXACT_CONFIRMATION_REQUIRED/);
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select maintenance.request_full_reset_from_sql($1)',[confirm]),/RESET_DBA_ONLY/);
  await db.exec('reset role');
  await db.exec("update maintenance.sandbox_reset_target set project_ref='wrong-project'");
  await assert.rejects(db.query('select maintenance.request_full_reset_from_sql($1)',[confirm]),/WRONG_RESET_PROJECT/);
  assert.equal(await count(db,'platform_private.super_admins'),1);
 }finally{await db.close()}
});
