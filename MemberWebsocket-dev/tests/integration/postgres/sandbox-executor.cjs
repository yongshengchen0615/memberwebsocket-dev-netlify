const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const database=require('./database.cjs');

const migrationDir=path.join(__dirname,'../../../supabase/migrations');
const filenames=[
  '20261023183000_approved_existing_sandbox_scope.sql',
  '20261023190000_sandbox_root_bootstrap_gate.sql',
  '20261023200000_sandbox_database_full_reset_executor.sql'
];
const merchant='business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const uid='U'+'b'.repeat(32);
const confirmation='RESET MEMBERWEBSOCKET TEST DATA';
const request='11111111-1111-4111-8111-111111111111';
const execute='select maintenance.execute_sandbox_database_reset($1,$2,$3) result';
const createFixture=(failBaseline=false)=>[
 'create schema maintenance;create schema platform_private;create schema booking_notifications;',
 'create schema line_config;create schema auth;create schema storage;',
 'create schema '+merchant+';',
 'create table public.admins(id uuid primary key default gen_random_uuid(),line_user_id text not null unique,display_name text not null,role text not null,status text not null);',
 'create table public.members(id int primary key);',
 'create table public.system_settings(id int primary key,state text not null);',
 'create table booking_notifications.outbox(id int primary key);',
 'create table platform_private.tenants(id int primary key);',
 'create table platform_private.super_admins(singleton boolean primary key,admin_id uuid references public.admins(id),enabled boolean,line_user_id text);',
 'create table platform_private.module_secrets(tenant_id int references platform_private.tenants(id) on delete restrict);',
 'create table platform_private.module_notification_routes(tenant_id int references platform_private.tenants(id) on delete restrict);',
 'create table platform_private.audit_events(id int primary key);',
 'create table platform_private.business_templates(version text primary key,snapshot jsonb not null);',
 'create table line_config.settings(id int primary key);',
 'create table line_config.audit_log(id int primary key);',
 'create table auth.users(id int primary key);create table storage.objects(id int primary key);',
 'create table '+merchant+'.admins(id int primary key);',
 'create table '+merchant+'.members(id int primary key);',
 'create table '+merchant+'.bookings(member_id int references '+merchant+'.members(id) on delete restrict);',
 "insert into public.admins(line_user_id,display_name,role,status) values('"+uid+"','CI root','admin','active');",
 'insert into public.members values(1);',
 "insert into public.system_settings values(1,'modified');",
 'insert into booking_notifications.outbox values(1);',
 'insert into platform_private.tenants values(1);',
 'insert into platform_private.super_admins select true,id,true,line_user_id from public.admins;',
 'insert into platform_private.module_secrets values(1);',
 'insert into platform_private.module_notification_routes values(1);',
 'insert into platform_private.audit_events values(1);',
 "insert into platform_private.business_templates values('v1','{}');",
 'insert into line_config.settings values(1);insert into line_config.audit_log values(1);',
 'insert into '+merchant+'.admins values(1);',
 'insert into '+merchant+'.members values(1);',
 'insert into '+merchant+'.bookings values(1);',
 'create function maintenance.ensure_required_system_baseline() returns void language plpgsql as $$ begin '+(failBaseline?"raise exception 'CI_INJECTED_BASELINE_FAILURE';":"insert into public.system_settings values(1,'ready');")+' end $$;',
 'create function maintenance.ensure_referral_reward_baseline() returns void language plpgsql as $$ begin null; end $$;',
 'create function maintenance.ensure_event_ticket_settings_baseline() returns void language plpgsql as $$ begin null; end $$;'
].join('\n');
async function setup(failBaseline=false){
 const {db}=await database();
 try{
  await db.exec(createFixture(failBaseline));
  for(const file of filenames)await db.exec(fs.readFileSync(path.join(migrationDir,file),'utf8'));
  return db;
 }catch(err){await db.close();throw err}
}
const plan=async db=>(await db.query('select maintenance.plan_sandbox_database_reset() p')).rows[0].p;
const proof=async db=>db.exec('update maintenance.sandbox_reset_target set backup_verified_at=now(),storage_restore_verified_at=now(),provider_isolation_verified_at=now()');
const count=async(db,t)=>Number((await db.query('select count(*)::int n from '+t)).rows[0].n);

test('AC-CLR-027: actual PG17 executor resets root, tenant, outbox and merchant after independently verified pg_dump/restore',async()=>{
 const db=await setup();
 try{
  const p=await plan(db);
  const {client:restored,checksum}=await db.backupRestore();
  assert.match(checksum,/^[a-f0-9]{64}$/);
  assert.equal(await count(db,'public.admins'),1);
  assert.equal(await count(db,'platform_private.tenants'),1);
  assert.equal(await count(db,merchant+'.bookings'),1);
  await proof(db);
  const result=(await db.query(execute,[request,p.fingerprint,confirmation])).rows[0].result;
  assert.equal(result.databaseReset,true);
  assert.equal(result.droppedBusinessSchemas,1);
  assert.equal(result.rootBootstrapRequired,true);
  for(const t of ['public.admins','public.members','platform_private.super_admins',
    'platform_private.tenants','platform_private.module_secrets','platform_private.module_notification_routes',
    'booking_notifications.outbox','platform_private.audit_events'])
    assert.equal(await count(db,t),0,t);
  assert.equal(await count(db,'platform_private.business_templates'),1);
  assert.equal(await count(db,'line_config.settings'),1);
  assert.deepEqual((await db.query('select state from public.system_settings')).rows,[{state:'ready'}]);
  assert.equal(Number((await db.query('select count(*)::int n from pg_namespace where nspname=$1',[merchant])).rows[0].n),0);
  assert.equal(Number((await restored.query('select count(*)::int n from public.admins')).rows[0].n),1);
  assert.equal(Number((await restored.query('select count(*)::int n from platform_private.tenants')).rows[0].n),1);
  assert.equal(Number((await restored.query('select count(*)::int n from '+merchant+'.bookings')).rows[0].n),1);
  const restoredPlan=(await restored.query('select maintenance.plan_sandbox_database_reset() p')).rows[0].p;
  assert.equal(restoredPlan.fingerprint,p.fingerprint,'actual restored content must match full approved application fingerprint');
  assert.equal(restoredPlan.tableCount,p.tableCount,'restored table inventory must match original');
  const bootstrap=(await db.query('select maintenance.bootstrap_sandbox_root($1,$2) result',
    [uid,'RESTORE ROOT AFTER VERIFIED SANDBOX RESET'])).rows[0].result;
  assert.equal(bootstrap.bootstrapped,true);
  assert.equal(await count(db,'platform_private.super_admins'),1);
  assert.equal(await count(db,'public.admins'),1);
  await assert.rejects(db.query('select maintenance.bootstrap_sandbox_root($1,$2)',
    [uid,'RESTORE ROOT AFTER VERIFIED SANDBOX RESET']),/VERIFIED_RESET_REQUIRED_BEFORE_ROOT_BOOTSTRAP/);
 }finally{await db.close()}
});

test('AC-CLR-028: two physical PG17 sessions serialize one successful reset and replay the same request exactly once',async()=>{
 const db=await setup();
 try{
  const p=await plan(db);await proof(db);
  const [one,two]=await Promise.all([db.connect(),db.connect()]);
  const both=await Promise.all([one.query(execute,[request,p.fingerprint,confirmation]),
    two.query(execute,[request,p.fingerprint,confirmation])]);
  assert.equal(both.filter(x=>x.rows[0].result.databaseReset===true).length,1);
  assert.equal(both.filter(x=>x.rows[0].result.alreadyCompleted===true).length,1);
  assert.equal(await count(db,'public.admins'),0);
  assert.equal(await count(db,'maintenance.sandbox_reset_epoch'),1);
  assert.equal((await db.query('select last_completed_request from maintenance.sandbox_reset_epoch')).rows[0].last_completed_request,request);
 }finally{await db.close()}
});

test('AC-CLR-029: PG17 raises during baseline and transaction restores every root/merchant table and original approval',async()=>{
 const db=await setup(true);
 try{
  const p=await plan(db);await proof(db);
  await assert.rejects(db.query(execute,[request,p.fingerprint,confirmation]),/CI_INJECTED_BASELINE_FAILURE/);
  for(const t of ['public.admins','platform_private.tenants','platform_private.module_secrets',
    'platform_private.module_notification_routes',merchant+'.bookings'])
    assert.equal(await count(db,t),1,t);
  assert.equal((await db.query('select last_completed_request from maintenance.sandbox_reset_epoch')).rows[0].last_completed_request,null);
  assert.equal((await db.query('select backup_verified_at is not null verified from maintenance.sandbox_reset_target')).rows[0].verified,true);
 }finally{await db.close()}
});
