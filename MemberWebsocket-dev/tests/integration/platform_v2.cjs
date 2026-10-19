'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const root='U'+'1'.repeat(32),manager='U'+'2'.repeat(32),other='U'+'3'.repeat(32);
const features=Object.fromEntries(['membership','points','events','calendar','integrations','booking','testing','usage'].map(k=>[k,k==='membership']));
const req='40000000-0000-4000-8000-000000000004';
const from=path.join(__dirname,'../../');
const baseSql=fs.readFileSync(path.join(from,'supabase/plans/p1_control_plane_schema_sandbox_ONLY.sql'),'utf8');
const v2Sql=fs.readFileSync(path.join(from,'v2/sql/01_platform_v2_rpc_sandbox.sql'),'utf8');
async function fresh(){const db=new PGlite();
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 await db.exec(baseSql);await db.exec(v2Sql);return db;
}
async function rpc(db,name,params){const keys=Object.keys(params);
 return db.transaction(async tx=>{
   await tx.exec('set local role service_role');
   return (await tx.query('select public.'+name+'('+keys.map((_,i)=>'$'+(i+1)).join(',')+') result',keys.map(k=>params[k]))).rows[0].result;
 });
}
async function grantSyntheticRoot(db){ // TEST FIXTURE ONLY; never production
 await db.query("insert into platform_private.platform_operators(line_user_id,role,enabled,approved_by,approved_at) values($1,'super_admin',true,'synthetic-test-operator',now())",[root]);
}
async function approve(db){
 await rpc(db,'v2_ensure_application',{p_actor:manager,p_name:'商家'});
 const mine=await rpc(db,'v2_merchant_bootstrap',{p_actor:manager});
 return rpc(db,'v2_approve',{p_actor:root,p_app_id:mine.application.id,p_features:features,p_req:req,p_hash:'a'.repeat(64)});
}
test('AC-V2-001: P1+V2 fresh schema is private and does not create or grant root',async()=>{
 const db=await fresh();try{
   assert.equal((await db.query('select count(*)::int n from platform_private.platform_operators')).rows[0].n,0);
   assert.equal((await db.query('select count(*)::int n from platform_private.tenant_feature_secrets')).rows[0].n,0);
   for(const role of ['anon','authenticated','service_role']){
     await db.exec('set role '+role);
     try{
       if(role==='service_role'){
         await assert.rejects(db.query("insert into platform_private.platform_operators(line_user_id,role,enabled,approved_by,approved_at) values($1,'super_admin',true,'test',now())",[root]),/permission denied/i);
         await assert.rejects(db.query('update platform_private.platform_operators set enabled=true'),/permission denied/i);
       }else{
         await assert.rejects(db.query('select * from platform_private.applications'),/permission denied/i);
         await assert.rejects(db.query('select public.v2_root_bootstrap($1)',[root]),/permission denied/i);
       }
     }finally{await db.exec('reset role')}
   }
 }finally{await db.close()}
});
test('AC-V2-002: applicant approval is exactly once and only queues isolated provisioning',async()=>{
 const db=await fresh();try{
   const first=await rpc(db,'v2_ensure_application',{p_actor:manager,p_name:'新商家'});
   const retry=await rpc(db,'v2_ensure_application',{p_actor:manager,p_name:'新商家'});
   assert.equal(first.application.id,retry.application.id);
   assert.equal((await db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,0);
   await assert.rejects(rpc(db,'v2_root_bootstrap',{p_actor:manager}),/V2_ROOT_REQUIRED/);
   const applied=await rpc(db,'v2_apply',{p_actor:manager,p_name:'商家 A',p_slug:'merchant-a'});
   await assert.rejects(rpc(db,'v2_approve',{p_actor:manager,p_app_id:applied.application.id,p_features:features,p_req:req,p_hash:'a'.repeat(64)}),/V2_ROOT_REQUIRED/);
   await grantSyntheticRoot(db);
   const result=await rpc(db,'v2_approve',{p_actor:root,p_app_id:applied.application.id,p_features:features,p_req:req,p_hash:'a'.repeat(64)});
   assert.equal(result.status,'pending_provisioning');
   assert.equal(result.credentialsConfigured,false);
   assert.deepEqual(await rpc(db,'v2_approve',{p_actor:root,p_app_id:applied.application.id,p_features:features,p_req:req,p_hash:'a'.repeat(64)}),result);
   await assert.rejects(rpc(db,'v2_approve',{p_actor:root,p_app_id:applied.application.id,p_features:features,p_req:req,p_hash:'b'.repeat(64)}),/V2_REQUEST_CONFLICT/);
   assert.equal((await db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,1);
   assert.equal((await db.query('select count(*)::int n from platform_private.provisioning_jobs')).rows[0].n,1);
   assert.equal((await db.query("select count(*)::int n from platform_private.audit_events where action='APPLICATION_APPROVED'")).rows[0].n,1);
   await assert.rejects(db.query("update platform_private.tenants set status='active'"),/check constraint|TENANT_NOT_PROVISIONED/i);
 }finally{await db.close()}
});
test('AC-V2-003: only root modifies feature grants with version lock and audit',async()=>{
 const db=await fresh();try{
   await grantSyntheticRoot(db);const tenant=await approve(db);
   const next={...features,booking:true};
   const payload={p_tenant:tenant.id,p_version:1,p_features:next,p_req:crypto.randomUUID(),p_hash:'b'.repeat(64)};
   await assert.rejects(rpc(db,'v2_update_features',{p_actor:manager,...payload}),/V2_ROOT_REQUIRED/);
   const saved=await rpc(db,'v2_update_features',{p_actor:root,...payload});
   assert.equal(saved.features.booking,true);assert.equal(saved.version,2);
   assert.deepEqual(await rpc(db,'v2_update_features',{p_actor:root,...payload}),saved);
   await assert.rejects(rpc(db,'v2_update_features',{p_actor:root,...payload,p_req:crypto.randomUUID()}),/V2_VERSION_CONFLICT/);
   assert.equal((await db.query('select owner_line_user_id from platform_private.tenants')).rows[0].owner_line_user_id,manager);
   assert.equal((await db.query("select count(*)::int n from platform_private.audit_events where action='TENANT_FEATURES_UPDATED'")).rows[0].n,1);
 }finally{await db.close()}
});
test('AC-V2-004: only approved owner configures enabled feature; root cannot see secret',async()=>{
 const db=await fresh();try{
   await grantSyntheticRoot(db);const tenant=await approve(db);
   const config={loginChannelId:'2011111111',liffId:'2011111111-test',messagingChannelId:'2012222222'};
   const envelope={version:1,iv:'A'.repeat(16),data:'A'.repeat(80)};
   const payload={p_version:1,p_config:config,p_envelope:envelope,p_req:crypto.randomUUID(),p_hash:'c'.repeat(64)};
   await assert.rejects(rpc(db,'v2_save_line',{p_actor:other,p_feature:'membership',...payload}),/V2_NOT_APPROVED/);
   await assert.rejects(rpc(db,'v2_save_line',{p_actor:manager,p_feature:'points',...payload}),/V2_FEATURE_DISABLED/);
   await assert.rejects(rpc(db,'v2_save_line',{p_actor:manager,p_feature:'membership',...payload,p_envelope:null}),/V2_CREDENTIALS_REQUIRED/);
   const row=await rpc(db,'v2_save_line',{p_actor:manager,p_feature:'membership',...payload});
   assert.equal(row.line.membership.liffId,config.liffId);assert.equal(row.credentialsConfigured,true);assert.equal(row.version,2);
   assert.ok(!JSON.stringify(row).includes(envelope.data));
   assert.deepEqual(await rpc(db,'v2_save_line',{p_actor:manager,p_feature:'membership',...payload}),row);
   const dashboard=await rpc(db,'v2_root_bootstrap',{p_actor:root});
   assert.deepEqual(dashboard.tenants[0].line,{});
   assert.equal((await db.query('select count(*)::int n from platform_private.tenant_feature_secrets')).rows[0].n,1);
   assert.equal((await db.query('select status from platform_private.tenants')).rows[0].status,'pending_provisioning');
 }finally{await db.close()}
});
test('AC-V2-005: rate limits and suspension block further merchant modifications',async()=>{
 const db=await fresh();try{
   await grantSyntheticRoot(db);await approve(db);
   const hash='d'.repeat(64);
   for(let i=0;i<15;i++)assert.equal(await rpc(db,'v2_rate_limit',{p_hash:hash,p_write:true}),true);
   assert.equal(await rpc(db,'v2_rate_limit',{p_hash:hash,p_write:true}),false);
   await db.exec("update platform_private.tenants set status='suspended'");
   await assert.rejects(rpc(db,'v2_save_line',{p_actor:manager,p_feature:'membership',p_version:1,
     p_config:{loginChannelId:'2011111111',liffId:'2011111111-test',messagingChannelId:'2012222222'},
     p_envelope:null,p_req:crypto.randomUUID(),p_hash:'c'.repeat(64)}),/V2_NOT_APPROVED/);
 }finally{await db.close()}
});
