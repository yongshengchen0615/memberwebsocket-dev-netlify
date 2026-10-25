// #48 SBX-02: physical PostgreSQL-only lifecycle tests. This file never
// connects to Supabase: database.cjs accepts only a disposable local CI service.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const database=require('./database.cjs');
const {setup,root,owner,other,features}=require('../fixtures/merchant-applications.cjs');

async function sandbox(){
 return setup({database:await database()});
}

test('SBX-02 A/B: separate approved owners survive replay, restore and role isolation',async()=>{
 const h=await sandbox();
 try{
  await h.qualify(owner);
  await h.qualify(other);
  const requestA=crypto.randomUUID();
  const submittedA=await h.submit(owner,'sbx-owner-a','Synthetic A',requestA);
  assert.deepEqual(await h.submit(owner,'sbx-owner-a','Synthetic A',requestA),submittedA);
  const submittedB=await h.submit(other,'sbx-owner-b','Synthetic B');
  const a=await h.review(submittedA,'approved',features(['membership']));
  const b=await h.review(submittedB,'approved',features(['booking']));
  assert.equal(a.tenant.status,'active');
  assert.equal(b.tenant.status,'active');
  assert.notEqual(a.tenant.id,b.tenant.id);
  assert.notEqual(a.tenant.runtime_schema,b.tenant.runtime_schema);
  assert.deepEqual((await h.list(owner)).map(x=>x.slug),['sbx-owner-a']);
  assert.deepEqual((await h.list(other)).map(x=>x.slug),['sbx-owner-b']);
  await assert.rejects(h.get(submittedB.id,owner),/PLATFORM_APPLICATION_NOT_FOUND/);
  await assert.rejects(h.get(submittedA.id,other),/PLATFORM_APPLICATION_NOT_FOUND/);
  assert.equal(await h.count('applications'),2);
  assert.equal(await h.count('tenants'),2);
  const snapshot=(await h.db.query(
   'select id,slug,applicant_line_user_id,qualification_id,status,version,tenant_id from platform_private.applications order by slug'
  )).rows;
  assert.deepEqual(snapshot.map(x=>x.status),['approved','approved']);
  const restored=await h.db.backupRestore();
  assert.match(restored.checksum,/^[a-f0-9]{64}$/);
  assert.deepEqual((await restored.client.query(
   'select id,slug,applicant_line_user_id,qualification_id,status,version,tenant_id from platform_private.applications order by slug'
  )).rows,snapshot);
  for(const role of ['anon','authenticated']){
   await restored.client.query('set role '+role);
   await assert.rejects(restored.client.query(
    'select * from platform_private.applications'
   ),/permission denied/);
   await assert.rejects(restored.client.query(
    'select public.platform_my_merchant_applications($1)',[owner]
   ),/permission denied/);
   await restored.client.query('reset role');
  }
  await restored.client.query('set role service_role');
  const read=(await restored.client.query(
   'select public.platform_my_merchant_applications($1) result',[other]
  )).rows;
  assert.deepEqual(read.map(x=>x.result.slug),['sbx-owner-b']);
  await restored.client.query('reset role');
 }finally{await h.db.close();}
});

test('SBX-02 interrupted concurrent seed: rollback leaves no application, replay commits exactly once',async()=>{
 const h=await sandbox();
 try{
  await h.qualify(owner);
  const a=await h.db.connect(),b=await h.db.connect();
  await a.query('set role service_role');
  await b.query('set role service_role');
  const pid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
  assert.notEqual((await a.query('select pg_backend_pid() pid')).rows[0].pid,pid);
  const request=crypto.randomUUID();
  const sql='select public.platform_submit_merchant_application($1,$2,$3,$4,null,null) result';
  const args=[owner,'Interrupted Synthetic','sbx-rollback',request];
  await a.query('begin');
  await a.query(sql,args);
  const contender=b.query(sql,args);
  contender.catch(()=>{});
  let waiting=false;
  for(let i=0;i<100;i++){
   const row=(await h.db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0];
   if(row?.wait_event_type==='Lock'){waiting=true;break;}
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok(waiting,'second physical session should wait for the interrupted seed');
  await a.query('rollback');
  const created=(await contender).rows[0].result;
  assert.equal(created.status,'pending');
  assert.deepEqual(await h.submit(owner,'sbx-rollback','Interrupted Synthetic',request),created);
  assert.equal(await h.count('applications'),1);
  assert.equal(await h.count('tenants'),0);
  assert.equal((await h.db.query(
   "select count(*)::int n from platform_private.audit_events where action='MERCHANT_APPLICATION_SUBMITTED'"
  )).rows[0].n,1);
  assert.equal((await h.db.query(
   "select count(*)::int n from platform_private.requests where operation='merchant_submit'"
  )).rows[0].n,1);
 }finally{await h.db.close();}
});
