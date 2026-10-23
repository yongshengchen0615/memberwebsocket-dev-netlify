const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const database=require('./database.cjs');
const {migration,root,manager}=require('../platform-fixture.cjs');
const qualification=fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations/20261023121931_admin_qualification_foundation.sql'),'utf8');
async function setup(){
 const {db}=await database();
 try{
  await db.exec(`create table public.admins(id uuid primary key default gen_random_uuid(),line_user_id text unique,display_name text,role text,status text);
   grant select on public.admins to service_role;`);
  await db.query("insert into public.admins(line_user_id,display_name,role,status)values($1,'Synthetic root','admin','active')",[root]);
  await db.exec(migration);await db.exec('update platform_private.super_admins set enabled=true');await db.exec(qualification);
  const first=await db.connect(),second=await db.connect();
  await first.query('set role service_role');await second.query('set role service_role');
  const firstPid=(await first.query('select pg_backend_pid() pid')).rows[0].pid;
  const secondPid=(await second.query('select pg_backend_pid() pid')).rows[0].pid;
  assert.notEqual(firstPid,secondPid);
  const blocked=async()=>{
   for(let attempt=0;attempt<100;attempt++){
    if((await db.query('select wait_event_type from pg_stat_activity where pid=$1',[secondPid])).rows[0]?.wait_event_type==='Lock')return;
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   throw Error('EXPECTED_SECOND_PHYSICAL_SESSION_LOCK_WAIT');
  };
  return{db,first,second,blocked};
 }catch(error){await db.close();throw error;}
}
const submit='select public.platform_submit_admin_qualification($1,$2,$3) result';
const review='select public.platform_review_admin_qualification($1,$2,$3,$4,$5,$6) result';

test('PostgreSQL 17 Q010: simultaneous explicit submissions create one pending qualification and one audit',async()=>{
 const h=await setup();try{
  await h.first.query('begin');const q=(await h.first.query(submit,[manager,'合成管理員',crypto.randomUUID()])).rows[0].result;
  const pending=h.second.query(submit,[manager,'合成管理員',crypto.randomUUID()]);pending.catch(()=>{});
  await h.blocked();await h.first.query('commit');const repeated=(await pending).rows[0].result;
  assert.equal(repeated.id,q.id);assert.equal(repeated.status,'pending');assert.equal(repeated.version,1);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.admin_qualifications')).rows[0].n,1);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='ADMIN_QUALIFICATION_SUBMITTED'")).rows[0].n,1);
 }finally{await h.db.close();}
});

test('PostgreSQL 17 Q011: competing approval/rejection of the same version commits exactly one decision',async()=>{
 const h=await setup();try{
  const q=(await h.first.query(submit,[manager,'合成管理員',crypto.randomUUID()])).rows[0].result;
  await h.first.query('begin');await h.first.query(review,[root,q.id,1,'approved','',crypto.randomUUID()]);
  const pending=h.second.query(review,[root,q.id,1,'rejected','合成退件',crypto.randomUUID()]);pending.catch(()=>{});
  await h.blocked();await h.first.query('commit');await assert.rejects(pending,/PLATFORM_CONFLICT/);
  const current=(await h.db.query('select status,version from platform_private.admin_qualifications')).rows[0];
  assert.deepEqual(current,{status:'approved',version:2});
  assert.equal((await h.db.query("select count(*)::int n from platform_private.requests where operation='qualification_review'")).rows[0].n,1);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='ADMIN_QUALIFICATION_APPROVED'")).rows[0].n,1);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,0);
 }finally{await h.db.close();}
});

test('PostgreSQL 17 Q012: the same approval request racing on two physical sessions changes the version only once',async()=>{
 const h=await setup();try{
  const q=(await h.first.query(submit,[manager,'合成管理員',crypto.randomUUID()])).rows[0].result;
  const args=[root,q.id,1,'approved','',crypto.randomUUID()];
  await h.first.query('begin');const approved=(await h.first.query(review,args)).rows[0].result;
  const pending=h.second.query(review,args);pending.catch(()=>{});
  await h.blocked();await h.first.query('commit');assert.deepEqual((await pending).rows[0].result,approved);
  assert.equal((await h.db.query('select version from platform_private.admin_qualifications')).rows[0].version,2);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='ADMIN_QUALIFICATION_APPROVED'")).rows[0].n,1);
 }finally{await h.db.close();}
});
