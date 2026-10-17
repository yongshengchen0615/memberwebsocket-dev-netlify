const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,shared,root,manager,key}=require('./platform-fixture.cjs');
async function approve(h,features=h.tenant.features){
 const app=await h.call({action:'platform.application.submit',businessName:'商家 A',slug:'merchant-a'},'manager');
 assert.equal(app.status,200,JSON.stringify(app));
 const pending=(await h.call({action:'platform.bootstrap'})).body.data.applications[0];
 const result=await h.call({action:'platform.application.approve',applicationId:pending.id,features,requestId:crypto.randomUUID()});
 assert.equal(result.status,200,JSON.stringify(result));
 return result.body.data.tenant;
}
const approvedLine=(h,enabled=['membership'])=>Object.fromEntries(Object.entries(h.tenant.line).map(([key,value])=>{
 const mapping={memberLiffId:'membership',pointsLiffId:'points',eventLiffId:'events',calendarLiffId:'calendar',bookingLiffId:'booking'};
 return [key,mapping[key]&&!enabled.includes(mapping[key])?'':value];
}));
test('AC-001/004/016: old root merchant create is denied; approved owner encrypts own LINE credentials',async()=>{
 const h=await fixture();try{
  assert.equal((await h.call(h.save)).status,410);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,0);
  const tenant=await approve(h);
  assert.equal(tenant.status,'pending_provisioning');
  assert.equal((await h.call({action:'platform.line.save',expectedVersion:1,requestId:crypto.randomUUID(),line:h.tenant.line,credentials:h.tenant.credentials})).status,403);
  const saved=await h.call({action:'platform.line.save',expectedVersion:1,requestId:crypto.randomUUID(),line:h.tenant.line,credentials:h.tenant.credentials},'manager');
  assert.equal(saved.status,200,JSON.stringify(saved));
  const cipher=(await h.db.query('select envelope from platform_private.tenant_secrets')).rows[0].envelope;
  const {openCredentials}=await shared('platform-crypto.mjs');
  assert.deepEqual(await openCredentials(tenant.id,cipher,key),h.tenant.credentials);
  const view=JSON.stringify({saved,listing:await h.call({action:'platform.bootstrap'}),audit:(await h.db.query('select detail from platform_private.audit_events')).rows});
  assert.ok(!view.includes(h.tenant.credentials.channelAccessToken));assert.ok(!view.includes(h.tenant.credentials.channelSecret));
 }finally{await h.db.close();}
});
test('AC-005/016: root feature grant is idempotent, optimistic-locked, audited, and cannot alter LINE',async()=>{
 const h=await fixture();try{
  const tenant=await approve(h);
  const features=Object.fromEntries(Object.keys(tenant.features).map(k=>[k,k==='membership']));
  const save={action:'platform.tenant.features.save',tenantId:tenant.id,expectedVersion:tenant.version,features,requestId:crypto.randomUUID()};
  assert.equal((await h.call(save,'manager')).status,403);
  const first=await h.call(save);assert.equal(first.status,200,JSON.stringify(first));
  assert.deepEqual(await h.call(save),first);
  assert.equal((await h.call({...save,features:{...features,booking:true}})).status,409);
  assert.equal((await h.call({...save,requestId:crypto.randomUUID()})).status,409);
  const row=(await h.db.query('select features,line_config,version,credentials_configured from platform_private.tenants where id=$1',[tenant.id])).rows[0];
  assert.deepEqual(row.features,features);assert.deepEqual(row.line_config,{});
  assert.equal(row.version,2);assert.equal(row.credentials_configured,false);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='TENANT_FEATURES_UPDATED'")).rows[0].n,1);
 }finally{await h.db.close();}
});
test('AC-005: two competing grant updates preserve one committed version and one audit',async()=>{
 const h=await fixture();try{
  const tenant=await approve(h);
  const results=await Promise.all(['points','booking'].map(f=>h.call({action:'platform.tenant.features.save',tenantId:tenant.id,expectedVersion:1,requestId:crypto.randomUUID(),features:Object.fromEntries(Object.keys(tenant.features).map(k=>[k,k===f]))})));
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  const row=(await h.db.query('select features,version from platform_private.tenants where id=$1',[tenant.id])).rows[0];
  assert.equal(row.version,2);assert.equal(Object.values(row.features).filter(Boolean).length,1);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='TENANT_FEATURES_UPDATED'")).rows[0].n,1);
 }finally{await h.db.close();}
});
test('AC-001/006: root revocation and isolation gate remain enforced',async()=>{
 const h=await fixture();try{
  const tenant=await approve(h);
  await assert.rejects(h.db.query("update platform_private.tenants set status='active' where id=$1",[tenant.id]),/isolation_gate/);
  assert.equal((await h.call({action:'platform.tenant.suspend',tenantId:tenant.id,expectedVersion:1,requestId:crypto.randomUUID()})).status,200);
  await h.db.query("update admins set status='suspended' where line_user_id=$1",[root]);
  assert.equal((await h.call({action:'platform.bootstrap'})).status,403);
  assert.equal((await h.call({action:'platform.tenant.features.save',tenantId:tenant.id,expectedVersion:2,features:tenant.features,requestId:crypto.randomUUID()})).status,403);
 }finally{await h.db.close();}
});
test('AC-001/013: private tables and root RPC deny direct anonymous access',async()=>{
 const h=await fixture();try{
  for(const role of ['anon','authenticated']){
   await h.db.exec('set role '+role);
   await assert.rejects(h.db.query('select * from platform_private.tenant_secrets'),/permission denied/);
   await assert.rejects(h.db.query('select public.platform_list_tenants($1)',[root]),/permission denied/);
   await assert.rejects(h.db.query('select public.platform_update_tenant_features($1,$2,$3,$4,$5,$6)',[root,crypto.randomUUID(),1,{},crypto.randomUUID(),'a'.repeat(64)]),/permission denied/);
   await h.db.exec('reset role');
  }
  await h.db.exec('grant usage on schema platform_private to authenticated; grant select on platform_private.tenants to authenticated');
  await approve(h);
  await h.db.exec('set role authenticated');
  assert.equal((await h.db.query('select * from platform_private.tenants')).rows.length,0);
  await h.db.exec('reset role');
 }finally{await h.db.close();}
});
test('AC-004: invalid ciphertext is rolled back atomically',async()=>{
 const h=await fixture();try{
  const tenant=await approve(h);
  const result=await h.rpc('platform_save_my_line',{p_actor:manager,p_expected_version:1,p_request_id:crypto.randomUUID(),p_payload_hash:'a'.repeat(64),p_line:approvedLine(h),p_secrets:{version:1,iv:'bad',data:'bad'}});
  assert.ok(result.error);
  const row=(await h.db.query('select version,credentials_configured from platform_private.tenants where id=$1',[tenant.id])).rows[0];
  assert.equal(row.version,1);assert.equal(row.credentials_configured,false);
 }finally{await h.db.close();}
});
test('ambiguous legacy installation never selects one of two root candidates',async()=>{
 const h=await fixture(2);try{assert.equal((await h.db.query('select count(*)::int n from platform_private.super_admins')).rows[0].n,0);assert.equal((await h.call({action:'platform.bootstrap'})).status,403);}finally{await h.db.close();}
});
test('merchant encryption key is resolved before writing encrypted LINE secrets',async()=>{
 const h=await fixture();try{
  const tenant=await approve(h),{createPlatformHandler}=await shared('platform-handler.mjs');
  let resolved=false;
  const handler=createPlatformHandler({db:{rpc:h.rpc},allowedOrigins:h.allowedOrigins,verifyIdentity:async()=>({lineUserId:manager,displayName:'manager'}),encryptionKey:async()=>{await Promise.resolve();resolved=true;return key;}});
  const res=await handler(new Request('https://backend.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({action:'platform.line.save',expectedVersion:1,requestId:crypto.randomUUID(),line:approvedLine(h),credentials:h.tenant.credentials,idToken:'token'})}));
  assert.equal(res.status,200);assert.equal(resolved,true);
  const cipher=(await h.db.query('select envelope from platform_private.tenant_secrets')).rows[0].envelope;
  const {openCredentials}=await shared('platform-crypto.mjs');
  assert.deepEqual(await openCredentials(tenant.id,cipher,key),h.tenant.credentials);
 }finally{await h.db.close();}
});
test('AC-009: platform-only LINE channel and root UID binding both required',async()=>{
 const h=await fixture();try{
  assert.equal((await h.call({action:'platform.bootstrap'},'legacy-root')).status,401);
  assert.equal((await h.call({action:'platform.bootstrap'},'manager')).status,403);
  await assert.rejects(h.db.query("update platform_private.super_admins set line_user_id='bad'"),/platform_super_admin_line_identity/);
  const newId='U'+'3'.repeat(32);
  await h.db.query('update platform_private.super_admins set line_user_id=$1 where singleton',[newId]);
  assert.equal((await h.call({action:'platform.bootstrap'},'root')).status,403);
  await h.call({action:'platform.application.submit',businessName:'換授權商家',slug:'rebind-root'},'manager');
  const apps=(await h.call({action:'platform.bootstrap'},'new-provider-root')).body.data.applications;
  assert.equal((await h.call({action:'platform.application.approve',applicationId:apps[0].id,features:h.tenant.features,requestId:crypto.randomUUID()},'new-provider-root')).status,200);
  assert.equal((await h.db.query("select actor from platform_private.audit_events where action='APPLICATION_APPROVED'")).rows[0].actor,newId);
  await h.db.exec('update platform_private.super_admins set enabled=false');
  assert.equal((await h.call({action:'platform.bootstrap'},'new-provider-root')).status,403);
 }finally{await h.db.close();}
});
test('rollback removes platform while preserving legacy member data',async()=>{
 const h=await fixture();try{
  await approve(h);await h.db.exec('insert into public.legacy_member_data default values');
  await h.db.exec(require('node:fs').readFileSync(require('node:path').join(__dirname,'../../supabase/rollback/product_platform_control_plane.sql'),'utf8'));
  assert.equal((await h.db.query('select count(*)::int n from public.admins')).rows[0].n,2);
  assert.equal((await h.db.query('select count(*)::int n from public.legacy_member_data')).rows[0].n,1);
  assert.equal((await h.db.query("select count(*)::int n from pg_namespace where nspname='platform_private'")).rows[0].n,0);
 }finally{await h.db.close();}
});

test('AC-010/011: applicant is isolated; root approves selected features; applicant cannot grant their own permissions',async()=>{
 const h=await fixture();try{
  const submitted=await h.call({action:'platform.application.submit',businessName:'新商家',slug:'merchant-self'},'manager');
  assert.equal(submitted.status,200,JSON.stringify(submitted));
  assert.equal(submitted.body.data.application.status,'pending');
  assert.equal(submitted.body.data.tenant,null);
  const pending=await h.call({action:'platform.application.bootstrap'},'manager');
  assert.equal(pending.body.data.application.businessName,'新商家');
  assert.equal((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,0);
  const rootListing=await h.call({action:'platform.bootstrap'});
  assert.equal(rootListing.body.data.applications.length,1);
  const app=rootListing.body.data.applications[0];
  const features=Object.fromEntries(Object.keys((await shared('platform-policy.mjs')).FEATURES).map(x=>[x,x==='membership'||x==='booking']));
  const request={action:'platform.application.approve',applicationId:app.id,features,requestId:crypto.randomUUID()};
  assert.equal((await h.call(request,'manager')).status,403);
  const approved=await h.call(request);
  assert.equal(approved.status,200,JSON.stringify(approved));
  assert.equal(approved.body.data.tenant.status,'pending_provisioning');
  assert.equal(approved.body.data.tenant.credentialsConfigured,false);
  assert.equal(approved.body.data.tenant.features.booking,true);
  assert.equal(approved.body.data.tenant.features.testing,false);
  assert.equal((await h.call(request)).status,200); // idempotent retry
  assert.equal((await h.call({...request,requestId:crypto.randomUUID()})).status,409);
  const mine=await h.call({action:'platform.application.bootstrap'},'manager');
  assert.equal(mine.body.data.application.status,'approved');
  assert.equal(mine.body.data.tenant.id,approved.body.data.tenant.id);
  assert.equal(mine.body.data.tenant.features.testing,false);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n,1);
  assert.equal((await h.db.query("select count(*)::int n from platform_private.audit_events where action='APPLICATION_APPROVED'")).rows[0].n,1);
 }finally{await h.db.close();}
});
test('AC-012: manager updates own LINE credentials only, secrets stay encrypted and feature grants unchanged',async()=>{
 const h=await fixture();try{
  await h.call({action:'platform.application.submit',businessName:'自助商家',slug:'self-line'},'manager');
  const list=await h.call({action:'platform.bootstrap'});const app=list.body.data.applications[0];
  const features=Object.fromEntries(Object.keys((await shared('platform-policy.mjs')).FEATURES).map(x=>[x,x==='membership']));
  const approval=await h.call({action:'platform.application.approve',applicationId:app.id,features,requestId:crypto.randomUUID()});
  assert.equal(approval.status,200);
  const tenant=approval.body.data.tenant;
  const line=approvedLine(h,['membership']),credentials=h.tenant.credentials;
  const save={action:'platform.line.save',expectedVersion:tenant.version,requestId:crypto.randomUUID(),line,credentials};
  assert.equal((await h.call(save,'root')).status,403); // owner identity not equal to root
  const result=await h.call(save,'manager');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.data.tenant.credentialsConfigured,true);
  assert.equal(result.body.data.tenant.features.booking,false);
  assert.equal((await h.call(save,'manager')).status,200);
  const savedId=tenant.id;
  const cipher=(await h.db.query('select envelope from platform_private.tenant_secrets where tenant_id=$1',[savedId])).rows[0].envelope;
  const {openCredentials}=await shared('platform-crypto.mjs');
  assert.deepEqual(await openCredentials(savedId,cipher,key),credentials);
  const noSecrets=JSON.stringify({result,mine:await h.call({action:'platform.application.bootstrap'},'manager'),audit:(await h.db.query('select detail from platform_private.audit_events')).rows});
  assert.ok(!noSecrets.includes(credentials.channelSecret));
  assert.ok(!noSecrets.includes(credentials.channelAccessToken));
  assert.equal((await h.call({...save,requestId:crypto.randomUUID(),expectedVersion:tenant.version,credentials:{channelAccessToken:'',channelSecret:''}},'manager')).status,409);
  const bad=await h.call({...save,requestId:crypto.randomUUID(),expectedVersion:2,features:Object.fromEntries(Object.keys(features).map(k=>[k,true]))},'manager');
  assert.equal(bad.status,200); // extra grants are ignored by self-service action
  assert.equal(bad.body.data.tenant.features.booking,false);
  const featuresRow=(await h.db.query('select features,status from platform_private.tenants where id=$1',[savedId])).rows[0];
  assert.deepEqual(featuresRow.features,features);assert.equal(featuresRow.status,'pending_provisioning');
 }finally{await h.db.close();}
});
test('AC-013: suspended merchant, unauthenticated and SQL public roles cannot change tenant LINE metadata',async()=>{
 const h=await fixture();try{
  const unauth=await h.call({action:'platform.application.submit',businessName:'X',slug:'merchant-x'},'invalid');
  assert.equal(unauth.status,401);
  await h.call({action:'platform.application.submit',businessName:'商家',slug:'merchant-suspend'},'manager');
  const app=(await h.call({action:'platform.bootstrap'})).body.data.applications[0];
  const features=Object.fromEntries(Object.keys((await shared('platform-policy.mjs')).FEATURES).map(x=>[x,false]));
  const approved=await h.call({action:'platform.application.approve',applicationId:app.id,features,requestId:crypto.randomUUID()});
  const tenant=approved.body.data.tenant;
  await h.call({action:'platform.tenant.suspend',tenantId:tenant.id,expectedVersion:1,requestId:crypto.randomUUID()});
  assert.equal((await h.call({action:'platform.line.save',expectedVersion:2,requestId:crypto.randomUUID(),line:h.tenant.line,credentials:h.tenant.credentials},'manager')).status,403);
  for(const role of ['anon','authenticated']){
    await h.db.exec('set role '+role);
    await assert.rejects(h.db.query('select * from platform_private.applications'),/permission denied/);
    await assert.rejects(h.db.query('select public.platform_my_application($1)',[manager]),/permission denied/);
    await h.db.exec('reset role');
  }
 }finally{await h.db.close();}
});
