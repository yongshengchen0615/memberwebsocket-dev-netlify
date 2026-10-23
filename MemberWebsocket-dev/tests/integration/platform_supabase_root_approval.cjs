const test=require('node:test');
const assert=require('node:assert/strict');
const {fixture,root,manager}=require('./platform-fixture.cjs');
const count=async(db,t)=>Number((await db.query('select count(*)::int n from '+t)).rows[0].n);

test('AC-PLAT-107: after full wipe, verified Platform visit produces disabled super_admins row; Supabase enabled toggle activates root',async()=>{
 const h=await fixture();
 try{
  await h.db.exec('delete from platform_private.super_admins;delete from public.admins;');
  const first=await h.call({action:'platform.bootstrap'},'root');
  assert.equal(first.status,403);
  assert.equal(first.body.error.code,'PLATFORM_ADMIN_REQUIRED');
  assert.deepEqual((await h.db.query('select enabled,line_user_id from platform_private.super_admins')).rows,
    [{enabled:false,line_user_id:root}]);
  assert.equal((await h.db.query('select role,status from public.admins')).rows[0].status,'pending');
  assert.equal((await h.rpc('platform_is_root_super_admin',{p_actor:root})).data,false);
  // Equivalent of trusted Supabase Table Editor update, not a website call.
  await h.db.exec('update platform_private.super_admins set enabled=true where singleton=true');
  assert.deepEqual((await h.db.query('select role,status from public.admins')).rows,[{role:'admin',status:'active'}]);
  assert.equal((await h.rpc('platform_is_root_super_admin',{p_actor:root})).data,true);
  assert.equal((await h.call({action:'platform.bootstrap'},'root')).status,200);
  assert.equal(await count(h.db,'platform_private.super_admins'),1);
  const audits=(await h.db.query("select action from platform_private.audit_events where action='PLATFORM_ROOT_ENABLED_IN_SUPABASE'")).rows;
  assert.equal(audits.length,1);
 }finally{await h.db.close()}
});

test('AC-PLAT-108: Supabase Table Editor disabling root revokes all protected API calls immediately',async()=>{
 const h=await fixture();
 try{
  assert.equal((await h.call({action:'platform.bootstrap'},'root')).status,200);
  await h.db.exec('update platform_private.super_admins set enabled=false where singleton=true');
  assert.equal((await h.call({action:'platform.bootstrap'},'root')).status,403);
  assert.equal((await h.call({action:'platform.application.approve',applicationId:'00000000-0000-4000-8000-000000000001',features:{}},'root')).status,403);
  const r=(await h.db.query('select action from platform_private.audit_events where action=$1',['PLATFORM_ROOT_DISABLED_IN_SUPABASE'])).rows;
  assert.equal(r.length,1);
 }finally{await h.db.close()}
});

test('AC-PLAT-109: merchant or Platform attendee cannot activate root through service-role RPCs or repeated login',async()=>{
 const h=await fixture();
 try{
  await h.db.exec('delete from platform_private.super_admins;delete from public.admins;');
  await h.call({action:'platform.bootstrap'},'manager');
  const candidate=(await h.db.query('select enabled,line_user_id from platform_private.super_admins')).rows[0];
  assert.equal(candidate.enabled,false);
  assert.equal(candidate.line_user_id,manager);
  const second=await h.call({action:'platform.bootstrap'},'root');
  assert.equal(second.status,403);
  assert.equal((await h.db.query('select line_user_id from platform_private.super_admins')).rows[0].line_user_id,manager);
  await assert.rejects(h.db.transaction(async tx=>{
   await tx.exec('set local role service_role');
   await tx.exec('update platform_private.super_admins set enabled=true where singleton=true');
  }),/permission denied|PLATFORM_SUPABASE_OWNER_APPROVAL_REQUIRED/i);
  assert.equal((await h.rpc('platform_is_root_super_admin',{p_actor:manager})).data,false);
  assert.equal((await h.rpc('platform_is_root_super_admin',{p_actor:root})).data,false);
  assert.equal(await count(h.db,'platform_private.super_admins'),1);
 }finally{await h.db.close()}
});

test('AC-PLAT-110: root identity cannot be replaced while enabled, and invalid grants are rejected',async()=>{
 const h=await fixture();
 try{
  await h.call({action:'platform.bootstrap'},'manager');
  await assert.rejects(
   h.db.query('update platform_private.super_admins set line_user_id=$1 where singleton',[manager]),
   /PLATFORM_DISABLE_ROOT_BEFORE_REASSIGNING_IDENTITY/);
  await h.db.exec('update platform_private.super_admins set enabled=false where singleton');
  await h.db.query('update platform_private.super_admins set line_user_id=$1 where singleton',[manager]);
  // Existing root admin row is active but belongs to a different verified
  // Provider identity. For backwards compatibility its binding can be changed
  // only through Supabase after explicitly disabling the old root.
  await h.db.exec('update platform_private.super_admins set enabled=true where singleton');
  assert.equal((await h.rpc('platform_is_root_super_admin',{p_actor:root})).data,false);
  assert.equal((await h.rpc('platform_is_root_super_admin',{p_actor:manager})).data,true);
 }finally{await h.db.close()}
});


test('AC-PLAT-111: Supabase owner checkbox completes pending reset bootstrap epoch without DBA SQL bootstrap',async()=>{
 const h=await fixture();
 try{
  await h.db.exec('delete from platform_private.super_admins; delete from public.admins;');
  await h.db.exec("create schema maintenance; create table maintenance.sandbox_reset_epoch(singleton boolean primary key,root_bootstrap_required boolean not null,last_completed_request uuid,bootstrapped_at timestamptz);");
  await h.db.exec("insert into maintenance.sandbox_reset_epoch(singleton,root_bootstrap_required,last_completed_request) values(true,true,gen_random_uuid());");
  const visitor=await h.call({action:'platform.bootstrap'},'root');
  assert.equal(visitor.status,403);
  const pending=(await h.db.query('select root_bootstrap_required,bootstrapped_at from maintenance.sandbox_reset_epoch')).rows[0];
  assert.equal(pending.root_bootstrap_required,true);
  assert.equal(pending.bootstrapped_at,null);
  await h.db.exec('update platform_private.super_admins set enabled=true where singleton=true');
  const done=(await h.db.query('select root_bootstrap_required,bootstrapped_at is not null as initialized from maintenance.sandbox_reset_epoch')).rows[0];
  assert.deepEqual(done,{root_bootstrap_required:false,initialized:true});
  assert.equal((await h.call({action:'platform.bootstrap'},'root')).status,200);
 }finally{await h.db.close()}
});


test('AC-PLAT-112: service-role registration RPC persists disabled singleton candidate in isolation',async()=>{
 const h=await fixture();
 try{
  await h.db.exec('delete from platform_private.super_admins; delete from public.admins;');
  const res=await h.rpc('platform_record_access_request',{p_actor:root,p_display_name:'verified LINE root'});
  assert.equal(res.error,null,res.error?.message || 'registration error');
  assert.equal(res.data.registered,true);
  assert.equal(res.data.pendingSupabaseApproval,true);
  assert.equal((await h.db.query('select enabled from platform_private.super_admins')).rows[0].enabled,false);
 }finally{await h.db.close()}
});
