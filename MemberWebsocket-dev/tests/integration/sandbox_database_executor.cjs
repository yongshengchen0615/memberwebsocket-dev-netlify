const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const dir=path.join(__dirname,'../../supabase/migrations');
const migrations=['20261023183000_approved_existing_sandbox_scope.sql','20261023190000_sandbox_root_bootstrap_gate.sql','20261023200000_sandbox_database_full_reset_executor.sql'];
const tenant='business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const request='11111111-1111-4111-8111-111111111111';
const confirmation='RESET MEMBERWEBSOCKET TEST DATA';
const sql='select maintenance.execute_sandbox_database_reset($1,$2,$3) result';
const count=async(db,t)=>Number((await db.query('select count(*)::int n from '+t)).rows[0].n);
async function fixture(options={}){
 const db=new PGlite();
 try{
  await db.exec([
   'create role anon;create role authenticated;create role service_role;',
   'create schema maintenance;create schema platform_private;create schema booking_notifications;',
   'create schema line_config;create schema auth;create schema storage;',
   'create schema '+tenant+';',
   'create table public.admins(id uuid primary key default gen_random_uuid(),line_user_id text unique not null,display_name text not null,role text not null,status text not null);',
   'create table public.members(id integer primary key);',
   'create table public.system_settings(id integer primary key,state text not null);',
   'create table booking_notifications.outbox(id integer primary key);',
   'create table platform_private.tenants(id integer primary key);',
   'create table platform_private.super_admins(singleton boolean primary key,admin_id uuid references public.admins(id) on delete restrict,enabled boolean,line_user_id text not null);',
   'create table platform_private.module_secrets(tenant_id integer references platform_private.tenants(id) on delete restrict);',
   'create table platform_private.module_notification_routes(tenant_id integer references platform_private.tenants(id) on delete restrict);',
   'create table platform_private.audit_events(id integer primary key);',
   'create table platform_private.business_templates(version text primary key,snapshot jsonb not null);',
   'create table line_config.settings(id integer primary key);',
   'create table line_config.audit_log(id integer primary key);',
   'create table auth.users(id integer primary key);',
   'create table storage.objects(id integer primary key);',
   'create table '+tenant+'.admins(id integer primary key);',
   'create table '+tenant+'.members(id integer primary key);',
   'create table '+tenant+'.bookings(member_id integer references '+tenant+'.members(id) on delete restrict);',
   options.cron===false?'':'create schema cron;create table cron.job(jobid integer primary key,active boolean);insert into cron.job values(1,true);',
   "insert into public.admins(line_user_id,display_name,role,status) values('Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','test','admin','active');",
   'insert into public.members values(1);',
   "insert into public.system_settings values(1,'modified');",
   'insert into booking_notifications.outbox values(1);',
   'insert into platform_private.tenants values(1);',
   'insert into platform_private.super_admins(singleton,admin_id,enabled,line_user_id) select true,id,true,line_user_id from public.admins;',
   'insert into platform_private.module_secrets values(1);',
   'insert into platform_private.module_notification_routes values(1);',
   'insert into platform_private.audit_events values(1);',
   "insert into platform_private.business_templates values('v1','{}'::jsonb);",
   'insert into line_config.settings values(1);',
   'insert into line_config.audit_log values(1);',
   'insert into '+tenant+'.admins values(1);',
   'insert into '+tenant+'.members values(1);',
   'insert into '+tenant+'.bookings values(1);',
   'create function maintenance.ensure_required_system_baseline() returns void language plpgsql as $$ begin '+(options.baselineFails?"raise exception 'SYNTHETIC_BASELINE_FAILED';":"insert into public.system_settings values(1,'ready');")+' end $$;',
   'create function maintenance.ensure_referral_reward_baseline() returns void language plpgsql as $$ begin null; end $$;',
   'create function maintenance.ensure_event_ticket_settings_baseline() returns void language plpgsql as $$ begin null; end $$;'
  ].join('\n'));
  for(const name of migrations)await db.exec(fs.readFileSync(path.join(dir,name),'utf8'));
  return db;
 }catch(e){await db.close();throw e}
}
const plan=async db=>(await db.query('select maintenance.plan_sandbox_database_reset() p')).rows[0].p;
const proofs=async db=>db.exec('update maintenance.sandbox_reset_target set backup_verified_at=now(),storage_restore_verified_at=now(),provider_isolation_verified_at=now()');
const execute=(db,p,id=request,confirm=confirmation)=>db.query(sql,[id,p.fingerprint,confirm]);

test('AC-CLR-016: comprehensive preview enumerates accounts, outbox and merchant, preserving config',async()=>{
 const db=await fixture();
 try{
  const p=await plan(db),names=p.tables.map(x=>x.schema+'.'+x.table);
  for(const name of ['public.admins','public.members','platform_private.super_admins','platform_private.tenants',
   'platform_private.module_secrets','platform_private.module_notification_routes','platform_private.audit_events',
   'booking_notifications.outbox','line_config.audit_log',tenant+'.admins',tenant+'.members',tenant+'.bookings'])
   assert.ok(names.includes(name),name);
  assert.equal(names.includes('platform_private.business_templates'),false);
  assert.equal(names.includes('line_config.settings'),false);
  assert.equal(p.executionAllowed,false);
  assert.equal(p.businessSchemas,1);
  assert.match(p.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal((await plan(db)).fingerprint,p.fingerprint);
  await db.exec("update public.system_settings set state='new-value-same-row-count'");
  assert.notEqual((await plan(db)).fingerprint,p.fingerprint);
 }finally{await db.close()}
});

test('AC-CLR-017: refuse without backup proofs, paused cron, Auth/Storage API cleanup or correct confirmation',async()=>{
 const db=await fixture();
 try{
  const p=await plan(db);
  await assert.rejects(execute(db,p,request,'WRONG'),/RESET_EXACT_CONFIRMATION_REQUIRED/);
  await assert.rejects(execute(db,p),/RESET_BACKUP_STORAGE_AND_PROVIDER_PROOF_REQUIRED/);
  await proofs(db);
  await assert.rejects(execute(db,p),/RESET_ACTIVE_CRON_JOBS_PRESENT/);
  await db.exec('update cron.job set active=false;insert into auth.users values(1)');
  await assert.rejects(execute(db,p),/RESET_AUTH_OR_STORAGE_API_CLEANUP_PENDING/);
  await db.exec('delete from auth.users;insert into storage.objects values(1)');
  await assert.rejects(execute(db,p),/RESET_AUTH_OR_STORAGE_API_CLEANUP_PENDING/);
  assert.equal(await count(db,'public.admins'),1);
  assert.equal(await count(db,'platform_private.tenants'),1);
 }finally{await db.close()}
});

test('AC-CLR-018: full transactional wipe removes admin/root, tenant schema; recreates functional baseline',async()=>{
 const db=await fixture();
 try{
  const p=await plan(db);
  await proofs(db);await db.exec('update cron.job set active=false');
  const result=(await execute(db,p)).rows[0].result;
  assert.equal(result.databaseReset,true);
  assert.equal(result.rootBootstrapRequired,true);
  assert.equal(result.droppedBusinessSchemas,1);
  assert.equal(result.truncatedTableCount,p.tableCount);
  assert.ok(result.removedRows>=11);
  for(const t of ['public.admins','public.members','platform_private.super_admins','platform_private.tenants',
   'platform_private.module_secrets','platform_private.module_notification_routes','platform_private.audit_events',
   'booking_notifications.outbox','line_config.audit_log'])
   assert.equal(await count(db,t),0,t);
  assert.equal(await count(db,'platform_private.business_templates'),1);
  assert.equal(await count(db,'line_config.settings'),1);
  assert.deepEqual((await db.query('select state from public.system_settings')).rows,[{state:'ready'}]);
  assert.equal((await db.query('select 1 from pg_namespace where nspname=$1',[tenant])).rows.length,0);
  assert.equal((await db.query('select root_bootstrap_required from maintenance.sandbox_reset_epoch')).rows[0].root_bootstrap_required,true);
  assert.equal((await execute(db,p)).rows[0].result.alreadyCompleted,true);
 }finally{await db.close()}
});

test('AC-CLR-019: failed baseline rolls back every table and schema removal',async()=>{
 const db=await fixture({baselineFails:true});
 try{
  const p=await plan(db);await proofs(db);await db.exec('update cron.job set active=false');
  await assert.rejects(execute(db,p),/SYNTHETIC_BASELINE_FAILED/);
  for(const t of ['public.admins','platform_private.tenants','platform_private.module_secrets',tenant+'.bookings'])
   assert.equal(await count(db,t),1,t);
  assert.equal((await db.query('select last_completed_request from maintenance.sandbox_reset_epoch')).rows[0].last_completed_request,null);
  assert.equal((await db.query('select backup_verified_at is not null ok from maintenance.sandbox_reset_target')).rows[0].ok,true);
 }finally{await db.close()}
});

test('AC-CLR-020: stale preview and newly created tenant table cannot be silently erased',async()=>{
 const db=await fixture({cron:false});
 try{
  const p=await plan(db);await proofs(db);
  await db.exec('insert into '+tenant+'.members values(2)');
  await assert.rejects(execute(db,p),/RESET_STALE_PREVIEW/);
  const p2=await plan(db);
  await db.exec('create table '+tenant+'.unreviewed_records(id integer primary key);insert into '+tenant+'.unreviewed_records values(1)');
  await assert.rejects(execute(db,p2),/RESET_STALE_PREVIEW/);
  assert.equal(await count(db,tenant+'.unreviewed_records'),1);
 }finally{await db.close()}
});

test('AC-CLR-021: no user-facing role can enumerate or wipe data',async()=>{
 const db=await fixture();
 try{
  for(const role of ['anon','authenticated','service_role'])
   for(const fn of ['maintenance.plan_sandbox_database_reset()','maintenance.execute_sandbox_database_reset(uuid,text,text)'])
    assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',[role,fn,'EXECUTE'])).rows[0].allowed,false,role+' '+fn);
 }finally{await db.close()}
});
