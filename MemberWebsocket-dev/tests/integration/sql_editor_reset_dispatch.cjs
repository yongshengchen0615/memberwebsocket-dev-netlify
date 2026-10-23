const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const migrations=[
 '20261023183000_approved_existing_sandbox_scope.sql',
 '20261023190000_sandbox_root_bootstrap_gate.sql',
 '20261023200000_sandbox_database_full_reset_executor.sql',
 '20261023212000_sql_editor_reset_worker_dispatch.sql',
 '20261023220000_direct_sql_editor_sandbox_reset.sql'
];
const dir=path.join(__dirname,'../../supabase/migrations');
const confirm='RESET MEMBERWEBSOCKET TEST DATA';
const tableCount=async(db,t)=>(await db.query('select count(*)::int n from '+t)).rows[0].n;
async function setup(){
 const db=new PGlite();
 try{
  await db.exec([
   'create role anon;create role authenticated;create role service_role;',
   'create schema maintenance;create schema platform_private;create schema booking_notifications;',
   'create schema line_config;create schema auth;create schema storage;',
   'create schema extensions;create schema net;create schema cron;',
   'create table public.admins(id uuid primary key default gen_random_uuid(),line_user_id text not null,display_name text not null,role text not null,status text not null);',
   'create table public.members(id int primary key);',
   'create table public.system_settings(id int primary key,state text not null);',
   'create table platform_private.super_admins(singleton boolean primary key,admin_id uuid,enabled boolean,line_user_id text);',
   'create table platform_private.tenants(id int primary key);',
   'create table platform_private.business_templates(version text primary key,snapshot jsonb not null);',
   'create table line_config.settings(id int primary key);',
   'create table auth.users(id int primary key);',
   'create table storage.objects(id int primary key);',
   'create table storage.buckets(id text primary key);',
   'create table cron.job(jobid bigint primary key,active boolean);',
   'create table net.queued(id bigint primary key,body jsonb not null);',
   "create function extensions.gen_random_bytes(p_n integer) returns bytea language sql as $$select decode(repeat('aa',p_n),'hex')$$;",
   "create function net.http_post(url text,body jsonb,params jsonb default '{}'::jsonb,headers jsonb default '{}'::jsonb,timeout_milliseconds integer default 2000) returns bigint language plpgsql as $$ declare v_body jsonb:=body; begin insert into net.queued(id,body) values((select coalesce(max(id)+1,123) from net.queued),v_body);return (select max(id) from net.queued);end $$;",
   "create function cron.alter_job(job_id bigint, active boolean default true) returns void language plpgsql as $$begin update cron.job set active=alter_job.active where jobid=job_id;end $$;",
   "create function maintenance.ensure_required_system_baseline() returns void language plpgsql as $$begin insert into public.system_settings values(1,'ready');end $$;",
   "create function maintenance.ensure_referral_reward_baseline() returns void language plpgsql as $$begin null;end $$;",
   "create function maintenance.ensure_event_ticket_settings_baseline() returns void language plpgsql as $$begin null;end $$;",
   "insert into public.admins values(gen_random_uuid(),'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','admin','admin','active');",
   'insert into platform_private.tenants values(1);',
   'insert into storage.objects values(1);',
   "insert into storage.buckets values('booking-receipts');",
   'insert into auth.users values(1);',
   'insert into cron.job values(1,true);'
  ].join('\n'));
  for(const file of migrations)await db.exec(fs.readFileSync(path.join(dir,file),'utf8'));
  return db;
 }catch(e){await db.close();throw e}
}
const request=async(db,confirmation=confirm)=>db.query('select maintenance.request_full_reset_from_sql($1) r',[confirmation]);
const getTicket=async db=>(await db.query('select body from net.queued')).rows[0].body;
const phase=(db,id,ticket,action,result=null)=>db.query('select public.maintenance_sql_reset_phase($1,$2,$3,$4) r',[id,ticket,action,result]);
const claim=(db,id,ticket)=>db.query('select public.maintenance_sql_reset_claim($1,$2) r',[id,ticket]);

test('AC-CLR-034: approved disposable sandbox can queue directly without backup/LINE approval flags',async()=>{
 const db=await setup();
 try{
  await assert.rejects(request(db,'wrong'),/RESET_EXACT_CONFIRMATION_REQUIRED/);
  assert.equal((await db.query('select count(*)::int n from maintenance.sql_full_reset_jobs')).rows[0].n,0);
  assert.equal((await db.query('select maintenance.latest_full_reset_status() r')).rows[0].r.state,'not_started');
  const flags=(await db.query('select backup_verified_at,storage_restore_verified_at,provider_isolation_verified_at from maintenance.sandbox_reset_target')).rows[0];
  assert.deepEqual(flags,{backup_verified_at:null,storage_restore_verified_at:null,provider_isolation_verified_at:null});
  const sent=(await request(db)).rows[0].r;
  assert.equal(sent.submitted,true);
  assert.equal(sent.completed,false);
  assert.equal(await tableCount(db,'public.admins'),1);
  assert.equal(await tableCount(db,'storage.objects'),1);
 }finally{await db.close()}
});

test('AC-CLR-035: one click queues only an authorized ticket, does not pretend data was deleted',async()=>{
 const db=await setup();
 try{
  const dispatched=(await request(db)).rows[0].r;
  assert.equal(dispatched.submitted,true);
  assert.equal(dispatched.completed,false);
  assert.equal(dispatched.message,'QUEUED_NOT_YET_CLEARED');
  assert.match(dispatched.jobId,/^[a-f0-9-]{36}$/);
  assert.equal(JSON.stringify(dispatched).includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),false);
  assert.equal(await tableCount(db,'net.queued'),1);
  assert.equal(await tableCount(db,'storage.objects'),1);
  assert.equal(await tableCount(db,'public.admins'),1);
  const job=(await db.query('select state,pg_net_request_id,ticket_sha256 from maintenance.sql_full_reset_jobs')).rows[0];
  assert.equal(job.state,'queued');
  assert.equal(Number(job.pg_net_request_id),123);
  assert.match(job.ticket_sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(request(db),/RESET_JOB_ALREADY_ACTIVE/);
 }finally{await db.close()}
});

test('AC-CLR-036: fake HTTP, replay, wrong ticket or unclean managed resources cannot wipe users',async()=>{
 const db=await setup();
 try{
  await request(db);
  const {job_id:id,ticket}=await getTicket(db);
  await assert.rejects(claim(db,id,'0'.repeat(64)),/RESET_INVALID_JOB_TICKET/);
  assert.equal((await claim(db,id,ticket)).rows[0].r.accepted,true);
  await assert.rejects(claim(db,id,ticket),/RESET_TICKET_EXPIRED_OR_CONSUMED/);
  await assert.rejects(phase(db,id,'0'.repeat(64),'finish'),/RESET_INVALID_RUNNING_JOB/);
  await phase(db,id,ticket,'pause');
  const before=(await phase(db,id,ticket,'inventory')).rows[0].r;
  assert.equal(Number(before.activeCron),0);
  assert.equal(Number(before.authUsers),1);
  assert.equal(Number(before.storageObjects),1);
  await assert.rejects(phase(db,id,ticket,'finish'),/RESET_MANAGED_RESOURCES_NOT_EMPTY/);
  assert.equal(await tableCount(db,'public.admins'),1);
 }finally{await db.close()}
});

test('AC-CLR-037: simulated supported API deletion followed by database reset produces durable success state',async()=>{
 const db=await setup();
 try{
  await request(db);
  const {job_id:id,ticket}=await getTicket(db);
  await claim(db,id,ticket);
  await phase(db,id,ticket,'pause');
  // Fixture represents external API success; no real Storage bytes in PGlite.
  await db.exec('delete from storage.objects;delete from auth.users;');
  const result=(await phase(db,id,ticket,'finish')).rows[0].r;
  assert.equal(result.databaseReset,true);
  assert.equal(await tableCount(db,'public.admins'),0);
  assert.equal(await tableCount(db,'platform_private.tenants'),0);
  const state=(await db.query('select maintenance.latest_full_reset_status() r')).rows[0].r;
  assert.equal(state.state,'completed');
  assert.equal((await db.query('select root_bootstrap_required from maintenance.sandbox_reset_epoch')).rows[0].root_bootstrap_required,true);
 }finally{await db.close()}
});

test('AC-CLR-038: failed API clear is logged and direct sandbox reset can be retried without backup flags',async()=>{
 const db=await setup();
 try{
  await request(db);
  const {job_id:id,ticket}=await getTicket(db);
  await claim(db,id,ticket);
  const failed=(await phase(db,id,ticket,'fail',{error:'STORAGE_API_FAILED'})).rows[0].r;
  assert.equal(failed.failed,true);
  const status=(await db.query('select maintenance.latest_full_reset_status() r')).rows[0].r;
  assert.equal(status.state,'failed');
  assert.equal(status.errorCode,'STORAGE_API_FAILED');
  const retried=(await request(db)).rows[0].r;
  assert.equal(retried.submitted,true);
  assert.equal(retried.completed,false);
  assert.equal(await tableCount(db,'maintenance.sql_full_reset_jobs'),2);
  assert.equal(await tableCount(db,'public.admins'),1);
 }finally{await db.close()}
});

test('AC-CLR-039: public website users and service role cannot mint new SQL reset jobs',async()=>{
 const db=await setup();
 try{
  for(const role of ['anon','authenticated','service_role']){
   for(const name of ['maintenance.request_full_reset_from_sql(text)','maintenance.latest_full_reset_status()']){
    assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',[role,name,'EXECUTE'])).rows[0].allowed,false);
   }
  }
  for(const role of ['anon','authenticated']){
   for(const fn of ['public.maintenance_sql_reset_claim(uuid,text)','public.maintenance_sql_reset_phase(uuid,text,text,jsonb)']){
    assert.equal((await db.query('select has_function_privilege($1,$2,$3) allowed',[role,fn,'EXECUTE'])).rows[0].allowed,false);
   }
  }
 }finally{await db.close()}
});


test('AC-CLR-046: do not allow direct DB reset while Auth, Storage or cron still owns data',async()=>{
 const db=await setup();
 try{
  const snapshot=(await db.query('select maintenance.plan_sandbox_database_reset() p')).rows[0].p;
  const statement='select maintenance.execute_sandbox_database_reset($1,$2,$3)';
  await assert.rejects(db.query(statement,['11111111-1111-4111-8111-111111111111',snapshot.fingerprint,confirm]),/RESET_AUTH_OR_STORAGE_API_CLEANUP_PENDING/);
  await db.exec('delete from auth.users; delete from storage.objects;');
  await assert.rejects(db.query(statement,['11111111-1111-4111-8111-111111111111',snapshot.fingerprint,confirm]),/RESET_ACTIVE_CRON_JOBS_PRESENT/);
  assert.equal(await tableCount(db,'public.admins'),1);
  assert.equal(await tableCount(db,'platform_private.tenants'),1);
 }finally{await db.close()}
});
test('AC-CLR-047: owner-approved project record remains required, even without backups',async()=>{
 const db=await setup();
 try{
  await db.exec('delete from maintenance.sandbox_reset_target;');
  await assert.rejects(request(db),/WRONG_RESET_PROJECT/);
  assert.equal(await tableCount(db,'net.queued'),0);
  assert.equal(await tableCount(db,'public.admins'),1);
 }finally{await db.close()}
});


test('AC-CLR-048: stale asynchronous net dispatch is marked failed so DBA can retry',async()=>{
 const db=await setup();
 try{
  const submitted=(await request(db)).rows[0].r;
  await assert.rejects(request(db),/RESET_JOB_ALREADY_ACTIVE/);
  await db.query("update maintenance.sql_full_reset_jobs set requested_at=now()-interval '10 minutes' where id=$1",[submitted.jobId]);
  const retried=(await request(db)).rows[0].r;
  assert.notEqual(retried.jobId,submitted.jobId);
  assert.equal((await db.query('select state from maintenance.sql_full_reset_jobs where id=$1',[submitted.jobId])).rows[0].state,'failed');
  assert.equal(await tableCount(db,'maintenance.sql_full_reset_jobs'),2);
  assert.equal(await tableCount(db,'net.queued'),2);
  assert.equal(await tableCount(db,'public.admins'),1);
 }finally{await db.close()}
});

test('AC-CLR-049: stale running background job cannot permanently block another SQL Editor request',async()=>{
 const db=await setup();
 try{
  const first=(await request(db)).rows[0].r;
  const {ticket}=await getTicket(db);
  await claim(db,first.jobId,ticket);
  await assert.rejects(request(db),/RESET_JOB_ALREADY_ACTIVE/);
  await db.query("update maintenance.sql_full_reset_jobs set started_at=now()-interval '40 minutes' where id=$1",[first.jobId]);
  const second=(await request(db)).rows[0].r;
  assert.equal(second.submitted,true);
  assert.equal((await db.query('select error_code from maintenance.sql_full_reset_jobs where id=$1',[first.jobId])).rows[0].error_code,'RESET_STALE_BACKGROUND_JOB_EXPIRED');
  assert.equal(await tableCount(db,'public.admins'),1);
 }finally{await db.close()}
});
