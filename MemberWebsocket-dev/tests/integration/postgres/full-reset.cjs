const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const database=require('./database.cjs');

const source=fs.readFileSync(path.join(__dirname,'../fixtures/ci-full-reset.sql'),'utf8');
const fakeBackup='b'.repeat(64);
const actor='ci-root-actor',reviewer='ci-separate-reviewer',confirmation='RESET SYNTHETIC DATABASE';
const resetSql='select maintenance.ci_reset_synthetic($1,$2,$3,$4,$5,$6,$7) as result';
const uuid=()=>crypto.randomUUID();

async function setup(){
 const {db}=await database();
 try {await db.exec(source);return db}
 catch(error){await db.close();throw error}
}
async function plan(db){return (await db.query('select maintenance.ci_reset_plan() as result')).rows[0].result}
const args=(id,p,backup=fakeBackup,overrides={})=>[
 id,p.fingerprint,backup,
 overrides.actor??actor,overrides.reviewer??reviewer,
 overrides.confirmation??confirmation,overrides.inject??false];
const count=async(db,table)=>Number((await db.query('select count(*)::int n from '+table)).rows[0].n);

test('AC-CLR-001/003: isolated reset removes all synthetic admin/member/merchant/Auth/Storage/outbox rows and reseeds a usable baseline',async()=>{
 const db=await setup();
 try{
  const p=await plan(db);
  assert.equal(p.environment,'synthetic_disposable_postgres');
  assert.equal(p.allowed,false);
  assert.equal(p.tableCount,19);
  assert.equal(p.rowCount,23);
  const out=(await db.query(resetSql,args(uuid(),p))).rows[0].result;
  assert.equal(out.systemReady,true);
  assert.equal(out.rootBootstrapRequired,true);
  assert.equal(out.externalProviderVerified,false);
  assert.equal(out.removedRows,p.rowCount);
  for(const table of [
   'public.admins','public.members','platform_private.super_admins','platform_private.tenants',
   'platform_private.module_secrets','platform_private.module_notification_routes',
   'platform_private.audit_events','booking_notifications.outbox',
   'business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.admins',
   'business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.members',
   'business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bookings',
   'business_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.outbox',
   'business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.admins',
   'business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.members',
   'business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.bookings',
   'business_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.outbox','auth.users','storage.objects'
  ])assert.equal(await count(db,table),0,table);
  assert.deepEqual((await db.query('select id,state from public.system_settings')).rows,[{id:1,state:'ready'}]);
  assert.deepEqual((await db.query('select required,enabled from maintenance.ci_root_bootstrap')).rows,
                   [{required:true,enabled:false}]);
  assert.equal(await count(db,'maintenance.ci_reset_audit'),1);
 }finally{await db.close()}
});

test('AC-CLR-002: confirmation, separate reviewer, plan and backup are all mandatory; no partial changes',async()=>{
 const db=await setup();
 try{
  const p=await plan(db),id=uuid();
  const cases=[
   [args(id,p,fakeBackup,{actor:'other'}),/CI_TWO_PERSON_REVIEW_REQUIRED/],
   [args(id,p,fakeBackup,{reviewer:actor}),/CI_TWO_PERSON_REVIEW_REQUIRED/],
   [args(id,p,fakeBackup,{confirmation:'REMOVE ALL DATA'}),/CI_EXACT_CONFIRMATION_REQUIRED/],
   [args(id,p,'not-a-checksum'),/CI_BACKUP_AND_PLAN_REQUIRED/],
   [[id,'a'.repeat(64),fakeBackup,actor,reviewer,confirmation,false],/CI_RESET_STALE_PLAN/]
  ];
  for(const [input,regex] of cases)await assert.rejects(db.query(resetSql,input),regex);
  assert.equal(await count(db,'public.members'),2);
  assert.equal(await count(db,'platform_private.tenants'),2);
  assert.equal(await count(db,'maintenance.ci_reset_audit'),0);
 }finally{await db.close()}
});

test('AC-CLR-004: injected failure after truncate rolls back all rows, root state and audit',async()=>{
 const db=await setup();
 try{
  const p=await plan(db);
  await assert.rejects(db.query(resetSql,args(uuid(),p,fakeBackup,{inject:true})),
                       /CI_INJECTED_TRANSACTION_FAILURE/);
  assert.equal(await count(db,'public.admins'),1);
  assert.equal(await count(db,'public.members'),2);
  assert.equal(await count(db,'platform_private.module_secrets'),2);
  assert.equal(await count(db,'storage.objects'),1);
  assert.equal(await count(db,'maintenance.ci_reset_audit'),0);
  assert.deepEqual((await db.query('select required,enabled from maintenance.ci_root_bootstrap')).rows,
                   [{required:false,enabled:true}]);
 }finally{await db.close()}
});

test('AC-CLR-004: physical concurrent requests serialize and same request id returns immutable outcome',async()=>{
 const db=await setup();
 try{
  const p=await plan(db),id=uuid();
  const [left,right]=await Promise.all([db.connect(),db.connect()]);
  const pair=await Promise.all([left.query(resetSql,args(id,p)),right.query(resetSql,args(id,p))]);
  assert.deepEqual(pair[0].rows[0].result,pair[1].rows[0].result);
  assert.equal(await count(db,'maintenance.ci_reset_audit'),1);
  await assert.rejects(db.query(resetSql,args(id,p,'c'.repeat(64))),/CI_RESET_REPLAY_CONFLICT/);
  await assert.rejects(db.query(resetSql,args(uuid(),p)),/CI_RESET_STALE_PLAN/);
  assert.equal(await count(db,'public.members'),0);
 }finally{await db.close()}
});

test('AC-CLR-005: a new table or unsilenced notifications fail closed; clients cannot invoke',async()=>{
 const db=await setup();
 try{
  const p=await plan(db);
  await db.exec('update maintenance.ci_dispatch_gate set blocked=false');
  await assert.rejects(db.query(resetSql,args(uuid(),p)),/CI_EXTERNAL_DISPATCH_NOT_BLOCKED/);
  await db.exec('update maintenance.ci_dispatch_gate set blocked=true');
  await db.exec('create table public.unreviewed_new_data(id int);');
  await assert.rejects(db.query('select maintenance.ci_reset_plan()'),/CI_RESET_UNKNOWN_TABLE_OR_SCHEMA_DRIFT/);
  await assert.rejects(db.query(resetSql,args(uuid(),p)),/CI_RESET_UNKNOWN_TABLE_OR_SCHEMA_DRIFT/);
  for(const role of ['anon','authenticated','service_role']){
   const query=await db.query('select has_function_privilege($1,$2,$3) allowed',
     [role,'maintenance.ci_reset_synthetic(uuid,text,text,text,text,text,boolean)','EXECUTE']);
   assert.equal(query.rows[0].allowed,false,role);
  }
  assert.equal(await count(db,'public.members'),2);
 }finally{await db.close()}
});

test('AC-CLR-004: verified pg_dump snapshot restores original synthetic accounts and constraints',async()=>{
 const db=await setup();
 try{
  const p=await plan(db);
  const {client:restored,checksum}=await db.backupRestore();
  assert.match(checksum,/^[a-f0-9]{64}$/);
  const result=(await db.query(resetSql,args(uuid(),p,checksum))).rows[0].result;
  assert.equal(result.systemReady,true);
  assert.equal(await count(db,'public.members'),0);
  assert.equal(Number((await restored.query('select count(*)::int n from public.members')).rows[0].n),2);
  assert.equal(Number((await restored.query('select count(*)::int n from platform_private.tenants')).rows[0].n),2);
  assert.equal(Number((await restored.query('select count(*)::int n from storage.objects')).rows[0].n),1);
  await assert.rejects(restored.query('delete from platform_private.tenants where id=1'),/foreign key/);
  assert.deepEqual((await restored.query('select required,enabled from maintenance.ci_root_bootstrap')).rows,
                   [{required:false,enabled:true}]);
 }finally{await db.close()}
});
