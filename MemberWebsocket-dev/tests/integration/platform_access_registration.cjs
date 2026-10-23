const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,root,manager}=require('./platform-fixture.cjs');

const count=async(db,table)=>Number((await db.query('select count(*)::int n from '+table)).rows[0].n);

test('AC-PLAT-101: after test reset, LINE-verified Platform visit writes a pending identity without self-escalation',async()=>{
 const h=await fixture();
 try{
  await h.db.exec('delete from platform_private.super_admins;delete from public.admins;');
  assert.equal(await count(h.db,'public.admins'),0);
  const denied=await h.call({action:'platform.bootstrap'},'root');
  assert.equal(denied.status,403);
  assert.equal(denied.body.error.code,'PLATFORM_ADMIN_REQUIRED');
  assert.equal(await count(h.db,'public.admins'),1,'candidate must be persisted for Supabase Table Editor');
  const pendingAdmin=(await h.db.query('select role,status from public.admins')).rows[0];
  assert.deepEqual(pendingAdmin,{role:'none',status:'pending'});
  const slot=(await h.db.query('select enabled,line_user_id from platform_private.super_admins')).rows[0];
  assert.deepEqual(slot,{enabled:false,line_user_id:root},'unapproved LINE visit must not grant root');
  const rows=(await h.db.query('select line_user_id,display_name,access_enabled,first_seen_at from platform_private.platform_access_requests')).rows;
  assert.equal(rows.length,1);
  assert.equal(rows[0].line_user_id,root);
  assert.equal(rows[0].access_enabled,false);
  const repeat=await h.call({action:'platform.bootstrap'},'root');
  assert.equal(repeat.status,403);
  assert.equal(await count(h.db,'platform_private.platform_access_requests'),1);
  assert.equal(await count(h.db,'platform_private.super_admins'),1,'repeated logins cannot add root records');
  assert.equal((await h.db.query('select first_seen_at from platform_private.platform_access_requests')).rows[0].first_seen_at.getTime(),rows[0].first_seen_at.getTime());
  assert.equal((await h.rpc('platform_is_super_admin',{p_actor:root})).data,false);
 }finally{await h.db.close()}
});

test('AC-PLAT-102: root may approve and revoke a verified candidate; old LINE token loses platform access immediately',async()=>{
 const h=await fixture();
 try{
  const denied=await h.call({action:'platform.bootstrap'},'manager');
  assert.equal(denied.status,403);
  let response=await h.call({action:'platform.bootstrap'});
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.body.data.canReviewPlatformAccess,true);
  assert.equal(response.body.data.operatorRequests.length,1);
  assert.equal(response.body.data.operatorRequests[0].lineUserId,manager);
  assert.equal(response.body.data.operatorRequests[0].allowed,false);
  const granted=await h.call({action:'platform.operator.review',targetLineUserId:manager,allowed:true});
  assert.equal(granted.status,200,JSON.stringify(granted.body));
  const accepted=await h.call({action:'platform.bootstrap'},'manager');
  assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.canReviewPlatformAccess,false);
  assert.deepEqual(accepted.body.data.operatorRequests,[]);
  const forbidden=await h.call({action:'platform.operator.review',targetLineUserId:root,allowed:true},'manager');
  assert.equal(forbidden.status,403,'delegates cannot approve another root or operator');
  assert.equal(forbidden.body.error.code,'PLATFORM_ROOT_REQUIRED');
  const revoked=await h.call({action:'platform.operator.review',targetLineUserId:manager,allowed:false});
  assert.equal(revoked.status,200,JSON.stringify(revoked.body));
  assert.equal((await h.call({action:'platform.bootstrap'},'manager')).status,403);
  const audits=(await h.db.query("select action from platform_private.audit_events where action like 'PLATFORM_OPERATOR_%' order by created_at")).rows.map(x=>x.action);
  assert.deepEqual(audits,['PLATFORM_OPERATOR_GRANTED','PLATFORM_OPERATOR_REVOKED']);
 }finally{await h.db.close()}
});

test('AC-PLAT-103: repeated LINE visits cannot undo a revocation or forge a display name or grant',async()=>{
 const h=await fixture();
 try{
  const spoof=await h.call({action:'platform.bootstrap',displayName:'Super Root',role:'admin',approved:true,accessEnabled:true},'manager');
  assert.equal(spoof.status,403);
  assert.equal((await h.db.query('select display_name from platform_private.platform_access_requests where line_user_id=$1',[manager])).rows[0].display_name,'商家管理員');
  await h.call({action:'platform.bootstrap'});
  await h.call({action:'platform.operator.review',targetLineUserId:manager,allowed:true});
  await h.call({action:'platform.operator.review',targetLineUserId:manager,allowed:false});
  await h.call({action:'platform.bootstrap'},'manager');
  assert.equal((await h.db.query('select access_enabled from platform_private.platform_access_requests where line_user_id=$1',[manager])).rows[0].access_enabled,false);
  assert.equal((await h.call({action:'platform.bootstrap'},'legacy-root')).status,401);
  assert.equal(await count(h.db,'platform_private.platform_access_requests'),2);
 }finally{await h.db.close()}
});

test('AC-PLAT-104: only enabled existing singleton root can review; delegates cannot self-approve',async()=>{
 const h=await fixture();
 try{
  await h.call({action:'platform.bootstrap'},'manager');
  const denied=await h.call({action:'platform.operator.review',targetLineUserId:manager,allowed:true},'manager');
  assert.equal(denied.status,403);
  const self=await h.call({action:'platform.operator.review',targetLineUserId:root,allowed:true});
  assert.equal(self.status,403);
  assert.equal(self.body.error.code,'PLATFORM_SELF_OR_ROOT_REVIEW_FORBIDDEN');
  await h.db.exec('update platform_private.super_admins set enabled=false where singleton=true');
  const disabled=await h.call({action:'platform.operator.review',targetLineUserId:manager,allowed:true});
  assert.equal(disabled.status,403);
  assert.equal((await h.db.query('select access_enabled from platform_private.platform_access_requests where line_user_id=$1',[manager])).rows[0].access_enabled,false);
  assert.equal(await count(h.db,'platform_private.audit_events'),0);
 }finally{await h.db.close()}
});

test('AC-PLAT-105: anon/authenticated cannot create, read, review or self-assign Platform roles through RPCs',async()=>{
 const h=await fixture();
 try{
  for(const role of ['anon','authenticated']){
   for(const signature of [
    'public.platform_record_access_request(text,text)',
    'public.platform_list_access_requests(text)',
    'public.platform_review_access_request(text,text,boolean)',
    'public.platform_is_super_admin(text)']){
    assert.equal((await h.db.query('select has_function_privilege($1,$2,$3) allowed',[role,signature,'EXECUTE'])).rows[0].allowed,false,role+' '+signature);
   }
  }
 }finally{await h.db.close()}
});
