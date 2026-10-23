const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const migrations=path.join(__dirname,'../../supabase/migrations');
const load=n=>fs.readFileSync(path.join(migrations,n),'utf8');

async function fixture(withCron=false){
 const db=new PGlite();
 await db.exec([
  'create role anon;create role authenticated;create role service_role;',
  'create schema maintenance;create schema platform_private;',
  'create schema auth;create schema storage;create schema booking_notifications;',
  'create schema business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;',
  withCron?'create schema cron;create table cron.job(jobid int primary key,active boolean);insert into cron.job values(1,true);':'',
  'create table public.admins(id integer primary key);',
  'create table public.members(id integer primary key);',
  'create table platform_private.super_admins(id integer primary key,enabled boolean);',
  'create table platform_private.tenants(id integer primary key);',
  'create table platform_private.applications(id integer primary key,tenant_id int references platform_private.tenants(id));',
  'create table platform_private.tenant_secrets(tenant_id int references platform_private.tenants(id));',
  'create table platform_private.audit_events(tenant_id int references platform_private.tenants(id));',
  'create table platform_private.requests(id integer primary key);',
  'create table platform_private.module_secrets(tenant_id int references platform_private.tenants(id) on delete restrict);',
  'create table platform_private.module_notification_routes(tenant_id int references platform_private.tenants(id) on delete restrict);',
  'create table auth.users(id integer primary key);',
  'create table storage.objects(id integer primary key);',
  'create table booking_notifications.outbox(id integer primary key);',
  'create table business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.admins(id integer primary key);',
  'create function maintenance.clear_public_data(confirm_clear boolean default false) returns table(truncated_table_count integer) language plpgsql as $$ begin truncate public.members; return query select 1; end $$;',
  'insert into public.admins values (10);insert into public.members values(20);',
  'insert into platform_private.super_admins values(10,true);',
  'insert into platform_private.tenants values(1);',
  'insert into platform_private.applications values(2,1);',
  'insert into platform_private.module_secrets values(1);',
  'insert into platform_private.module_notification_routes values(1);',
  'insert into auth.users values(1);insert into storage.objects values(1);',
  'insert into booking_notifications.outbox values(1);',
  'insert into business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.admins values(1);'
 ].join('\n'));
 await db.exec(load('20261018182000_remove_all_business_data.sql'));
 await db.exec(load('20261023150000_full_reset_preflight.sql'));
 await db.exec(load('20261023174600_guard_unsafe_legacy_reset.sql'));
 await db.exec(load('20261023183000_approved_existing_sandbox_scope.sql'));
 return db;
}
const count=async(db,table)=>(await db.query('select count(*)::int n from '+table)).rows[0].n;

test('AC-CLR-006: SQL Editor readiness reports all roles, merchants, managed assets and explicit blockers',async()=>{
 const db=await fixture();
 try{
  const p=(await db.query('select maintenance.full_reset_readiness() status')).rows[0].status;
  assert.equal(p.state,'blocked');
  assert.equal(p.canExecute,false);
  assert.equal(p.counts.publicAdmins,1);
  assert.equal(p.counts.publicMembers,1);
  assert.equal(p.counts.platformRootGrants,1);
  assert.equal(p.counts.platformTenants,1);
  assert.equal(p.counts.merchantSchemas,1);
  assert.equal(p.counts.managedAuthUsers,1);
  assert.equal(p.counts.storageObjects,1);
  assert.equal(p.counts.activeScheduledJobs,0);
  assert.equal(p.preview.executionAllowed,false);
  assert.equal(p.requiredBeforeFullReset.length,7);
 }finally{await db.close()}
});

test('AC-CLR-007: even exact legacy confirmation refuses before clearing any table or changing root',async()=>{
 const db=await fixture();
 try{
  for(const confirmation of [null,'WRONG','REMOVE ALL DATA']){
   const sql='select * from maintenance.remove_all_data($1)';
   await assert.rejects(db.query(sql,[confirmation]),confirmation==='REMOVE ALL DATA'?/FULL_RESET_NOT_READY/:/CONFIRM_REMOVE_ALL_DATA_REQUIRED/);
  }
  for(const t of ['public.admins','public.members','platform_private.super_admins',
                  'platform_private.tenants','platform_private.module_secrets',
                  'platform_private.module_notification_routes','storage.objects',
                  'auth.users','booking_notifications.outbox'])
   assert.equal(await count(db,t),1,t);
  assert.equal((await db.query('select enabled from platform_private.super_admins')).rows[0].enabled,true);
 }finally{await db.close()}
});

test('AC-CLR-008: readiness detects active scheduler without trying to stop a real worker',async()=>{
 const db=await fixture(true);
 try{
  const one=(await db.query('select maintenance.full_reset_readiness() r')).rows[0].r;
  assert.equal(one.counts.activeScheduledJobs,1);
  await db.exec('update cron.job set active=false');
  const two=(await db.query('select maintenance.full_reset_readiness() r')).rows[0].r;
  assert.equal(two.counts.activeScheduledJobs,0);
  assert.equal(one.canExecute,false);
  assert.equal(two.canExecute,false);
 }finally{await db.close()}
});

test('AC-CLR-009: preview and guard have no PUBLIC, anon, authenticated or service role EXECUTE',async()=>{
 const db=await fixture();
 try{
  for(const fn of ['maintenance.preview_full_reset()','maintenance.full_reset_readiness()','maintenance.remove_all_data(text)']){
   for(const role of ['anon','authenticated','service_role'])
    assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',[role,fn,'EXECUTE'])).rows[0].allowed,false,role+' '+fn);
  }
 }finally{await db.close()}
});

test('AC-CLR-010: owner-approved existing Supabase sandbox stays blocked until actual backup and provider verification',async()=>{
 const db=await fixture();
 try{
  const s=(await db.query('select maintenance.sandbox_reset_status() as r')).rows[0].r;
  assert.equal(s.projectRef,'dbuquirnaskrwcamdxki');
  assert.equal(s.existingProjectApprovedAsSandbox,true);
  assert.equal(s.separateProjectRequired,false);
  assert.equal(s.canPermanentlyErase,false);
  assert.equal(s.databaseBackupVerified,false);
  assert.equal(s.storageRestoreVerified,false);
  assert.equal(s.providerIsolationVerified,false);
  assert.equal(s.readiness.canExecute,false);
  assert.equal((await db.query('select count(*)::int n from public.admins')).rows[0].n,1);
 }finally{await db.close()}
});

test('AC-CLR-011: only the approved project ref and DBA can read sandbox designation',async()=>{
 const db=await fixture();
 try{
  for(const role of ['anon','authenticated','service_role']){
   assert.equal((await db.query('select has_function_privilege($1,$2,$3) as allowed',
    [role,'maintenance.sandbox_reset_status()','EXECUTE'])).rows[0].allowed,false,role);
   assert.equal((await db.query('select has_table_privilege($1,$2,$3) as allowed',
    [role,'maintenance.sandbox_reset_target','SELECT'])).rows[0].allowed,false,role);
  }
  await assert.rejects(db.exec("update maintenance.sandbox_reset_target set project_ref='zrdpsobxaehqukacjjss'"),
    /no_unverified_backup_proof|check constraint/i);
  const s=(await db.query('select maintenance.sandbox_reset_status() as r')).rows[0].r;
  assert.equal(s.projectRef,'dbuquirnaskrwcamdxki');
 }finally{await db.close()}
});
