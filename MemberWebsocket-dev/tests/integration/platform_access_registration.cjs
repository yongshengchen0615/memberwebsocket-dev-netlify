const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,root,manager}=require('./platform-fixture.cjs');
const count=async(db,t)=>Number((await db.query('select count(*)::int n from '+t)).rows[0].n);
const row=async(db,id)=>(await db.query('select line_user_id,display_name,singleton,admin_id,enabled,first_seen_at,last_seen_at from platform_private.super_admins where line_user_id=$1',[id])).rows[0];

test('AC-PLAT-201: validated Platform LINE login writes a pending super_admins record and never grants itself',async()=>{
 const h=await fixture();
 try{
  const first=await h.call({action:'platform.bootstrap'},'manager');
  assert.equal(first.status,403);
  assert.equal(first.body.error.code,'PLATFORM_ADMIN_REQUIRED');
  let r=await row(h.db,manager);
  assert.equal(r.line_user_id,manager);
  assert.equal(r.display_name,'商家管理員');
  assert.equal(r.singleton,null);
  assert.equal(r.admin_id,null);
  assert.equal(r.enabled,false);
  assert.equal((await h.rpc('platform_is_super_admin',{p_actor:manager})).data,false);
  const before=r.first_seen_at.getTime();
  await h.call({action:'platform.bootstrap'},'manager');
  assert.equal(await count(h.db,'platform_private.super_admins'),2);
  r=await row(h.db,manager);
  assert.equal(r.first_seen_at.getTime(),before);
  assert.equal(r.enabled,false);
 }finally{await h.db.close()}
});

test('AC-PLAT-202: editing enabled only in Supabase table immediately activates a verified operator and revocation blocks stale LINE tokens',async()=>{
 const h=await fixture();
 try{
  await h.call({action:'platform.bootstrap'},'manager');
  await h.db.query('update platform_private.super_admins set enabled=true where line_user_id=$1',[manager]);
  assert.equal((await h.call({action:'platform.bootstrap'},'manager')).status,200);
  assert.equal((await h.rpc('platform_is_super_admin',{p_actor:manager})).data,true);
  await h.db.query('update platform_private.super_admins set enabled=false where line_user_id=$1',[manager]);
  assert.equal((await h.call({action:'platform.bootstrap'},'manager')).status,403);
  await h.call({action:'platform.bootstrap'},'manager');
  assert.equal((await row(h.db,manager)).enabled,false,'LINE relogin cannot undo owner revocation');
  const audits=(await h.db.query("select action from platform_private.audit_events where action like 'PLATFORM_SUPABASE_%' and detail->>'targetLineUserId'='U22222222222222222222222222222222' order by created_at")).rows.map(x=>x.action);
  assert.deepEqual(audits,['PLATFORM_SUPABASE_ACCESS_GRANTED','PLATFORM_SUPABASE_ACCESS_REVOKED']);
  assert.equal((await h.call({action:'platform.application.approve',requestId:crypto.randomUUID(),applicationId:crypto.randomUUID(),features:h.tenant.features},'manager')).status,403);
 }finally{await h.db.close()}
});

test('AC-PLAT-203: Platform controls are not able to approve operators, even if owner is logged in',async()=>{
 const h=await fixture();
 try{
  await h.call({action:'platform.bootstrap'},'manager');
  const result=await h.call({action:'platform.operator.review',targetLineUserId:manager,allowed:true});
  assert.equal(result.status,403);
  assert.equal(result.body.error.code,'PLATFORM_SUPABASE_ONLY_APPROVAL');
  assert.equal((await row(h.db,manager)).enabled,false);
  const rootRow=await row(h.db,root);
  assert.equal(rootRow.singleton,true);
  assert.ok(rootRow.admin_id);
  assert.equal(rootRow.enabled,true);
  await assert.rejects(h.db.query("update platform_private.super_admins set singleton=true where line_user_id=$1",[manager]),/super_admins_root_shape|super_admins_single_root_idx/);
 }finally{await h.db.close()}
});

test('AC-PLAT-204: untrusted body, wrong LINE channel and missing legacy admin must never grant control',async()=>{
 const h=await fixture();
 try{
  const forged=await h.call({action:'platform.bootstrap',enabled:true,admin_id:crypto.randomUUID(),lineUserId:root,displayName:'Root'},'manager');
  assert.equal(forged.status,403);
  let r=await row(h.db,manager);
  assert.equal(r.enabled,false);
  assert.equal(r.display_name,'商家管理員','trusted LINE verifier supplies displayName');
  assert.equal((await h.call({action:'platform.bootstrap'},'legacy-root')).status,401);
  await h.db.query("update public.admins set status='suspended' where line_user_id=$1",[root]);
  assert.equal((await h.call({action:'platform.bootstrap'})).status,403);
  assert.equal((await h.rpc('platform_is_root_super_admin',{p_actor:root})).data,false);
 }finally{await h.db.close()}
});

test('AC-PLAT-205: private super_admins cannot be edited by anon/authenticated; internal RPCs may not grant access',async()=>{
 const h=await fixture();
 try{
  for(const role of ['anon','authenticated']){
   assert.equal((await h.db.query('select has_function_privilege($1,$2,$3) allowed',
    [role,'public.platform_record_access_request(text,text)','EXECUTE'])).rows[0].allowed,false);
   assert.equal((await h.db.query('select has_function_privilege($1,$2,$3) allowed',
    [role,'public.platform_review_access_request(text,text,boolean)','EXECUTE'])).rows[0].allowed,false);
   await h.db.exec('set role '+role);
   await assert.rejects(h.db.query('select * from platform_private.super_admins'),/permission denied/);
   await h.db.exec('reset role');
  }
  await h.call({action:'platform.bootstrap'},'manager');
  assert.equal((await h.db.query("select has_column_privilege('service_role','platform_private.super_admins','enabled','UPDATE') allowed")).rows[0].allowed,false);
  assert.equal((await h.db.query("select has_column_privilege('service_role','platform_private.super_admins','line_user_id','INSERT') allowed")).rows[0].allowed,true);
  await h.db.exec('set role service_role');
  await assert.rejects(h.db.query('update platform_private.super_admins set enabled=true where line_user_id=$1',[manager]),/permission denied/);
  await assert.rejects(h.db.query('insert into platform_private.super_admins(line_user_id,enabled) values ($1,true)',['U'+'4'.repeat(32)]),/permission denied/);
  await h.db.exec('reset role');
  const internal=await h.rpc('platform_review_access_request',{p_actor:root,p_target:manager,p_allow:true});
  assert.ok(internal.error,'even service role cannot grant via former Platform review RPC');
 }finally{await h.db.close()}
});

test('AC-PLAT-206: multiple authenticated candidates create distinct rows and only specifically enabled user gets access',async()=>{
 const h=await fixture();
 try{
  await h.call({action:'platform.bootstrap'},'manager');
  await h.db.query('select public.platform_record_access_request($1,$2)', ['U'+'3'.repeat(32),'Second operator']);
  assert.equal(await count(h.db,'platform_private.super_admins'),3);
  await h.db.query('update platform_private.super_admins set enabled=true where line_user_id=$1',[manager]);
  assert.equal((await row(h.db,manager)).enabled,true);
  assert.equal((await row(h.db,'U'+'3'.repeat(32))).enabled,false);
  const r=await h.db.query('select count(*)::int n from platform_private.super_admins where singleton is true');
  assert.equal(r.rows[0].n,1);
 }finally{await h.db.close()}
});
