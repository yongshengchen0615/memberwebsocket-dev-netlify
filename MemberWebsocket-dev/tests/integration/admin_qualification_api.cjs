const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {fixture,root,manager}=require('./platform-fixture.cjs');
async function setup(rateLimit){
 const h=await fixture(1,true,rateLimit);
 try{
  await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations/20261023121931_admin_qualification_foundation.sql'),'utf8'));
  h.api=(action,body={},token='manager')=>h.call({action:'platform.qualification.'+action,...body},token);
  h.submit=(body={})=>h.api('submit',{requestId:crypto.randomUUID(),...body});
  h.review=(q,decision='approved',reason='',body={},token='root')=>h.api('review',{
   qualificationId:q.id,expectedVersion:q.version,decision,reason,requestId:crypto.randomUUID(),...body,
  },token);
  h.snapshot=async()=> (await h.db.query(`select
   (select count(*)::int from platform_private.admin_qualifications) qualifications,
   (select count(*)::int from platform_private.applications) merchants,
   (select count(*)::int from platform_private.tenants) tenants,
   (select count(*)::int from platform_private.requests) requests,
   (select count(*)::int from platform_private.audit_events) audits`)).rows[0];
  return h;
 }catch(e){await h.db.close();throw e;}
}
function qualification(response){assert.equal(response.status,200,JSON.stringify(response.body));return response.body.data.qualification;}

test('AC-MMA-API-001: qualification bootstrap is a pure read, and only explicit submit creates pending qualification',async()=>{
 const h=await setup();try{
  const before=await h.snapshot();
  assert.equal(qualification(await h.api('bootstrap')),null);
  assert.equal(qualification(await h.api('bootstrap')),null);
  assert.deepEqual(await h.snapshot(),before);
  const q=qualification(await h.submit());assert.equal(q.status,'pending');assert.equal(q.version,1);
  assert.equal(qualification(await h.api('bootstrap')).id,q.id);
  assert.equal((await h.snapshot()).merchants,0);assert.equal((await h.snapshot()).tenants,0);
 }finally{await h.db.close();}
});

test('AC-MMA-API-002: applicant Channel and verified LINE identity override spoofed client actor, role and name',async()=>{
 const h=await setup();try{
  const q=qualification(await h.submit({actor:root,lineUserId:root,role:'root',displayName:'forged',status:'approved'}));
  assert.equal(q.status,'pending');assert.equal(q.displayName,'商家管理員');
  const row=(await h.db.query('select applicant_line_user_id from platform_private.admin_qualifications')).rows[0];
  assert.equal(row.applicant_line_user_id,manager);
  assert.equal(h.providerCalls.at(-1).channel,'2010791619');
  const snapshot=await h.snapshot();
  for(const action of ['bootstrap','submit','list','review']){
   const r=await h.api(action,{business:'merchant-a',requestId:crypto.randomUUID()},action==='list'||action==='review'?'root':'manager');
   assert.equal(r.status,400);assert.equal(r.body.error.code,'PLATFORM_INVALID_INPUT');
  }
  assert.deepEqual(await h.snapshot(),snapshot);
 }finally{await h.db.close();}
});

test('AC-MMA-API-003: only a current Platform administrator can list/review, and approval creates no merchant or root',async()=>{
 const h=await setup();try{
  const q=qualification(await h.submit());
  assert.equal((await h.api('list')).status,403);assert.equal((await h.review(q,'approved','',{},'manager')).status,403);
  assert.equal((await h.api('list',{},'legacy-root')).status,401);
  const list=await h.api('list',{},'root');assert.equal(list.status,200);
  assert.equal(list.body.data.qualifications.length,1);assert.equal(list.body.data.qualifications[0].applicantLineUserId,manager);
  const approved=qualification(await h.review(q));assert.equal(approved.status,'approved');assert.equal(approved.version,2);
  const counts=await h.snapshot();assert.equal(counts.merchants,0);assert.equal(counts.tenants,0);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.super_admins where enabled')).rows[0].n,1);
 }finally{await h.db.close();}
});

test('AC-MMA-API-004: duplicate requests are idempotent and changed review contents/stale versions return conflict',async()=>{
 const h=await setup();try{
  const requestId=crypto.randomUUID(),q=qualification(await h.submit({requestId}));
  assert.deepEqual(qualification(await h.submit({requestId})),q);
  const reviewId=crypto.randomUUID(),approved=qualification(await h.review(q,'approved','',{requestId:reviewId}));
  assert.deepEqual(qualification(await h.review(q,'approved','',{requestId:reviewId})),approved);
  assert.equal((await h.review(q,'rejected','different',{requestId:reviewId})).body.error.code,'PLATFORM_REQUEST_CONFLICT');
  const stale=await h.review(q,'rejected','stale');assert.equal(stale.status,409);assert.equal(stale.body.error.code,'PLATFORM_CONFLICT');
  assert.equal(qualification(await h.api('bootstrap')).status,'approved');
 }finally{await h.db.close();}
});

test('AC-MMA-API-005: rejection/resubmission and suspension/replay/resume follow current SQL state',async()=>{
 const h=await setup();try{
  const submitId=crypto.randomUUID(),q=qualification(await h.submit({requestId:submitId}));
  const rejected=qualification(await h.review(q,'rejected','資料不足'));assert.equal(rejected.reviewReason,'資料不足');
  const pending=qualification(await h.submit());assert.equal(pending.id,q.id);assert.equal(pending.status,'pending');
  const approveId=crypto.randomUUID(),approved=qualification(await h.review(pending,'approved','',{requestId:approveId}));
  const suspended=qualification(await h.review(approved,'suspended','暫停資格'));assert.ok(suspended.accessRevokedBefore);
  const denied=await h.submit();assert.equal(denied.status,403);assert.equal(denied.body.error.code,'PLATFORM_QUALIFICATION_SUSPENDED');
  assert.equal(qualification(await h.submit({requestId:submitId})).status,'suspended');
  assert.equal(qualification(await h.review(pending,'approved','',{requestId:approveId})).status,'suspended');
  assert.equal(qualification(await h.review(suspended)).status,'approved');
  const illegal=await h.review(qualification(await h.api('bootstrap')),'rejected','late');
  assert.equal(illegal.status,409);assert.equal(illegal.body.error.code,'PLATFORM_QUALIFICATION_TRANSITION');
 }finally{await h.db.close();}
});

test('AC-MMA-API-006: invalid UUID/version/decision/reason causes no state, audit or idempotency writes',async()=>{
 const h=await setup();try{
  const q=qualification(await h.submit()),before=await h.snapshot();
  for(const body of [{qualificationId:'bad'},{requestId:'bad'},{expectedVersion:0},{expectedVersion:1.5},{expectedVersion:'1'},
   {decision:'active'},{decision:null},{decision:'rejected',reason:' '},{decision:'suspended',reason:''},{reason:'x'.repeat(501)},{reason:42}]){
   const r=await h.review(q,'approved','',body);assert.equal(r.status,400,JSON.stringify(body));
  }
  for(const requestId of [null,'',42,'bad'])assert.equal((await h.submit({requestId})).status,400);
  assert.deepEqual(await h.snapshot(),before);assert.equal(qualification(await h.api('bootstrap')).status,'pending');
 }finally{await h.db.close();}
});

test('AC-MMA-API-007: root revocation blocks even previously successful review request replays',async()=>{
 const h=await setup();try{
  const q=qualification(await h.submit()),requestId=crypto.randomUUID();
  qualification(await h.review(q,'approved','',{requestId}));
  await h.db.exec('update platform_private.super_admins set enabled=false');
  const before=await h.snapshot();
  assert.equal((await h.review(q,'approved','',{requestId})).status,403);
  assert.equal((await h.api('list',{},'root')).status,403);
  assert.deepEqual(await h.snapshot(),before);
 }finally{await h.db.close();}
});

test('AC-MMA-API-008: unauthenticated/invalid tokens cannot read or create qualifications',async()=>{
 const h=await setup();try{
  const before=await h.snapshot();
  for(const action of ['bootstrap','submit','list','review'])for(const token of ['',null,'invalid'])
   assert.equal((await h.api(action,{requestId:crypto.randomUUID()},token)).status,401);
  assert.deepEqual(await h.snapshot(),before);
 }finally{await h.db.close();}
});

test('AC-MMA-API-009: missing qualification migration fails closed with sanitized 503 responses',async()=>{
 const h=await fixture();try{
  for(const [action,token]of [['bootstrap','manager'],['submit','manager'],['list','root']]){
   const r=await h.call({action:'platform.qualification.'+action,requestId:crypto.randomUUID()},token);
   assert.equal(r.status,503);assert.equal(r.body.error.code,'PLATFORM_DATABASE_UNAVAILABLE');
   assert.doesNotMatch(JSON.stringify(r.body),/does not exist|platform_private|SELECT|idToken/);
  }
 }finally{await h.db.close();}
});

test('AC-MMA-API-010: missing qualification ID returns 404 without changing another applicant',async()=>{
 const h=await setup();try{
  const q=qualification(await h.submit()),before=await h.snapshot();
  const r=await h.review({...q,id:crypto.randomUUID()});
  assert.equal(r.status,404);assert.equal(r.body.error.code,'PLATFORM_QUALIFICATION_NOT_FOUND');
  assert.deepEqual(await h.snapshot(),before);assert.equal(qualification(await h.api('bootstrap')).id,q.id);
 }finally{await h.db.close();}
});

test('AC-MMA-API-011: non-singleton Platform administrator needs DBA approval and loses review access immediately on revocation',async()=>{
 const h=await setup();try{
  const q=qualification(await h.submit()),operator='U'+'3'.repeat(32);
  assert.equal((await h.call({action:'platform.bootstrap'},'new-provider-root')).status,403);
  assert.equal((await h.api('list',{},'new-provider-root')).status,403);
  await h.db.query('update platform_private.super_admins set enabled=true where line_user_id=$1',[operator]);
  const flags=(await h.db.query('select public.platform_is_super_admin($1) operator, public.platform_is_root_super_admin($1) root',[operator])).rows[0];
  assert.deepEqual(flags,{operator:true,root:false});
  assert.equal((await h.api('list',{},'new-provider-root')).body.data.qualifications.length,1);
  const requestId=crypto.randomUUID();
  assert.equal(qualification(await h.review(q,'approved','',{requestId},'new-provider-root')).status,'approved');
  await h.db.query('update platform_private.super_admins set enabled=false where line_user_id=$1',[operator]);
  const before=await h.snapshot();
  assert.equal((await h.api('list',{},'new-provider-root')).status,403);
  assert.equal((await h.review(q,'approved','',{requestId},'new-provider-root')).status,403);
  assert.deepEqual(await h.snapshot(),before);
 }finally{await h.db.close();}
});

test('AC-MMA-API-012: qualification actions use read/write rate budgets and limiter rejection/failure cannot mutate qualifications',async()=>{
 let outcome={data:true,error:null};const calls=[];
 const h=await setup(p=>{calls.push(p);return outcome;});try{
  const q=qualification(await h.submit());calls.length=0;
  qualification(await h.api('bootstrap'));
  qualification(await h.submit());
  assert.equal((await h.api('list',{},'root')).status,200);
  qualification(await h.review(q));
  assert.deepEqual(calls.map(p=>p.p_is_write),[false,true,false,true]);
  const before=await h.snapshot();
  for(const decision of [{data:false,error:null},{data:null,error:{message:'synthetic limiter failure'}}]){
   outcome=decision;
   for(const action of ['bootstrap','submit','list','review']){
    const r=await h.api(action,{requestId:crypto.randomUUID()},['list','review'].includes(action)?'root':'manager');
    assert.equal(r.status,decision.error?503:429);
    assert.equal(r.body.error.code,decision.error?'RATE_LIMIT_UNAVAILABLE':'RATE_LIMITED');
   }
  }
  assert.deepEqual(await h.snapshot(),before);
 }finally{await h.db.close();}
});

for(const invalid of ['requestId array','qualificationId array','PostgreSQL integer overflow']){
 test('AC-MMA-API-013: reject '+invalid+' as invalid input before review writes',async()=>{
  const h=await setup();try{
   const q=qualification(await h.submit()),before=await h.snapshot();
   const body=invalid==='requestId array'?{requestId:[crypto.randomUUID()]}:
    invalid==='qualificationId array'?{qualificationId:[q.id]}:{expectedVersion:2147483648};
   const r=await h.review(q,'approved','',body);
   assert.equal(r.status,400);assert.equal(r.body.error.code,'PLATFORM_INVALID_INPUT');
   assert.deepEqual(await h.snapshot(),before);assert.equal(qualification(await h.api('bootstrap')).status,'pending');
  }finally{await h.db.close();}
 });
}

test('AC-MMA-API-013: array request ID cannot submit an application',async()=>{
 const h=await setup();try{
  const before=await h.snapshot();
  const r=await h.submit({requestId:[crypto.randomUUID()]});
  assert.equal(r.status,400);assert.equal(r.body.error.code,'PLATFORM_INVALID_INPUT');
  assert.deepEqual(await h.snapshot(),before);
 }finally{await h.db.close();}
});
