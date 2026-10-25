// Breaks caught: messaging requirements blocking a valid LIFF, foreign LIFF
// acceptance, secret reuse after channel changes, and cross-scope/replay writes.
const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./business-platform-fixture.cjs'),{key}=require('./platform-fixture.cjs');
const owner='U'+'2'.repeat(32),features=Object.fromEntries(['membership','points','events','calendar','booking','testing','integrations','usage'].map(k=>[k,true]));
const liffs={membership:'memberLiffId',points:'pointsLiffId',events:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'};
const lineFor=(feature,extra={})=>({adminChannelId:'2010791619',adminLiffId:'2010791619-admin',memberChannelId:'2010787602',messagingChannelId:'',[liffs[feature]]:'2010787602-'+feature,...extra});
const empty={channelAccessToken:'',channelSecret:''};
async function setup(){const h=await fixture(),tenant=await h.approve(owner,'liff-only-shop',features);return {...h,tenant,save:(feature,line=lineFor(feature),extra={})=>h.call({action:'platform.line.save',business:tenant.slug,feature,line,credentials:empty,expectedVersion:1,requestId:crypto.randomUUID(),...extra},'manager')};}
test('#124 all five LIFF-only modules save without creating secrets and public bootstrap returns their own matched Login/LIFF',async()=>{
 const h=await setup();try{
  let version=1;
  for(const [feature,liff] of Object.entries(liffs)){
   const result=await h.save(feature,lineFor(feature),{expectedVersion:version});
   assert.equal(result.status,200,JSON.stringify(result));version++;
   const module=result.body.data.tenant.moduleLine[feature];
   assert.equal(module.credentialsConfigured,false);assert.equal(module.liffReady,true);assert.equal(module.line[liff],'2010787602-'+feature);
   const publicEntry=await h.call({action:'platform.business.public',business:h.tenant.slug,feature});
   assert.equal(publicEntry.status,200);assert.equal(publicEntry.body.data.line[liff],'2010787602-'+feature);
   assert.equal(publicEntry.body.data.line.memberChannelId,'2010787602');
  }
  assert.equal((await h.db.query('select count(*)::int n from platform_private.module_secrets')).rows[0].n,0);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.tenant_secrets')).rows[0].n,0);
 }finally{await h.db.close();}
});
test('#124 module LIFF requires a valid matched Login channel and rejects incomplete or partial Messaging credentials',async()=>{
 const h=await setup();try{
  for(const line of [lineFor('calendar',{calendarLiffId:''}),lineFor('calendar',{calendarLiffId:'2099999999-other'}),lineFor('calendar',{memberChannelId:'bad'}),lineFor('calendar',{messagingChannelId:'bad'})]){
   const result=await h.save('calendar',line);assert.equal(result.status,400);assert.equal(result.body.error.code,'INVALID_TENANT');
  }
  const partial=await h.save('calendar',lineFor('calendar'),{credentials:{channelAccessToken:'synthetic-access-token-123456',channelSecret:''}});
  assert.equal(partial.status,400);assert.equal((await h.db.query('select version from platform_private.tenants')).rows[0].version,1);
 }finally{await h.db.close();}
});
test('#124 LIFF-only notification save/test fail with setup error and calendar has no push API',async()=>{
 const h=await setup();try{
  let version=1;
  for(const feature of Object.keys(liffs)){
   const saved=await h.save(feature,lineFor(feature),{expectedVersion:version++});assert.equal(saved.status,200);
   for(const action of ['platform.notifications.save','platform.notifications.test']){
    const r=await h.call({action,business:h.tenant.slug,feature,purpose:'member',mode:'inherit',expectedVersion:version,requestId:crypto.randomUUID()},'manager');
    assert.equal(r.body.error.code,feature==='calendar'?'INVALID_NOTIFICATION_ROUTE':'NOTIFICATION_NOT_CONFIGURED');
   }
  }
  assert.equal((await h.db.query("select count(*)::int n from platform_private.requests where operation like 'notification%'")).rows[0].n,0);
 }finally{await h.db.close();}
});
test('#124 module channel rotation cannot reuse a stored envelope; same-channel LIFF edits preserve encryption and notification routes',async()=>{
 const h=await setup();try{
  const credentials={channelAccessToken:'synthetic-original-access-token-123456',channelSecret:'a'.repeat(32)};
  let saved=await h.save('booking',lineFor('booking',{messagingChannelId:'2010123456'}),{credentials});assert.equal(saved.status,200);
  const before=(await h.rpc('platform_module_credentials',{p_tenant_id:h.tenant.id,p_feature:'booking'})).data;
  const {openCredentials}=await import('../../supabase/functions/_shared/platform-crypto.mjs');
  assert.equal(before.scope,'module');assert.equal((await openCredentials(h.tenant.id+':booking',before.envelope,key)).channelAccessToken,credentials.channelAccessToken);
  await assert.rejects(openCredentials(h.tenant.id+':points',before.envelope,key));
  await h.db.query("update platform_private.tenants set module_line=jsonb_set(module_line,'{booking,notifications}','{\"member\":{\"mode\":\"custom\",\"channelId\":\"2010555555\",\"verifiedAt\":\"2026-01-01T00:00:00Z\"}}') where id=$1",[h.tenant.id]);
  const changed=await h.save('booking',lineFor('booking',{messagingChannelId:'2010999999'}),{expectedVersion:2});
  assert.equal(changed.status,400,JSON.stringify(changed));assert.equal(changed.body.error.code,'PLATFORM_CREDENTIALS_REQUIRED');
  assert.equal((await h.db.query('select version from platform_private.tenants')).rows[0].version,2);
  saved=await h.save('booking',lineFor('booking',{messagingChannelId:'2010123456',bookingLiffId:'2010787602-new'}),{expectedVersion:2});
  assert.equal(saved.status,200);assert.equal(saved.body.data.tenant.moduleLine.booking.notifications.member.verifiedAt,'2026-01-01T00:00:00Z');
  assert.deepEqual((await h.rpc('platform_module_credentials',{p_tenant_id:h.tenant.id,p_feature:'booking'})).data,before);
 }finally{await h.db.close();}
});
test('#124 LIFF-only SQL preserves merchant scope, version and replay fences including revoked access',async()=>{
 const h=await setup();try{
  const other=await h.approve(owner,'second-liff-shop',features),requestId=crypto.randomUUID();
  const saved=await h.save('calendar',lineFor('calendar'),{requestId});assert.equal(saved.status,200);
  assert.equal((await h.save('calendar',lineFor('calendar'),{requestId})).status,200);
  assert.equal((await h.save('calendar',lineFor('calendar',{calendarLiffId:'2010787602-changed'}),{requestId})).body.error.code,'PLATFORM_REQUEST_CONFLICT');
  assert.equal((await h.save('points',lineFor('points'),{requestId})).body.error.code,'PLATFORM_REQUEST_CONFLICT');
  assert.equal((await h.save('calendar',lineFor('calendar'),{requestId,business:other.slug})).body.error.code,'PLATFORM_REQUEST_CONFLICT');
  assert.equal((await h.save('calendar')).body.error.code,'PLATFORM_CONFLICT');
  const foreign=await h.approve('U'+'3'.repeat(32),'foreign-liff-shop',features);
  assert.equal((await h.save('calendar',lineFor('calendar'),{business:foreign.slug})).body.error.code,'PLATFORM_APPLICATION_NOT_FOUND');
  await h.db.query("update platform_private.tenants set features=jsonb_set(features,'{calendar}','false') where id=$1",[h.tenant.id]);
  assert.equal((await h.save('calendar',lineFor('calendar'),{requestId})).body.error.code,'FEATURE_DISABLED');
  await h.db.query("update platform_private.tenants set status='suspended' where id=$1",[h.tenant.id]);
  assert.equal((await h.save('points')).status,403);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.module_secrets')).rows[0].n,0);
  assert.deepEqual((await h.db.query('select module_line from platform_private.tenants where id=$1',[other.id])).rows[0].module_line,{});
 }finally{await h.db.close();}
});
test('#124 inherited notification setup verifies the stored module channel and preserves legacy tenant envelopes without provider sends',async()=>{
 const h=await setup();try{
  const {sealCredentials}=await import('../../supabase/functions/_shared/platform-crypto.mjs');
  const legacy={channelAccessToken:'synthetic-legacy-notification-token-123456',channelSecret:'a'.repeat(32)},legacyLine=lineFor('booking',{messagingChannelId:'2010123456'});
  await h.db.query('insert into platform_private.tenant_secrets(tenant_id,envelope)values($1,$2)',[h.tenant.id,await sealCredentials(h.tenant.id,legacy,key)]);
  await h.db.query('update platform_private.tenants set credentials_configured=true,line_config=$2 where id=$1',[h.tenant.id,legacyLine]);
  const {createPlatformHandler}=await import('../../supabase/functions/_shared/platform-handler.mjs');
  let valid=false;const provider=[];
  const handler=createPlatformHandler({db:{rpc:h.rpc},allowedOrigins:h.allowedOrigins,encryptionKey:()=>key,verifyApplicantIdentity:async()=>({lineUserId:owner,issuedAtMs:Date.now()}),verifyIdentity:()=>assert.fail('merchant scope required'),fetchImpl:async(url)=>{provider.push(url);assert.equal(url,'https://api.line.me/v2/oauth/verify');return new Response(JSON.stringify({client_id:valid?'2010123456':'2099999999',expires_in:3600}));}});
  const save=async()=>{const r=await handler(new Request('https://backend.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({action:'platform.notifications.save',business:h.tenant.slug,idToken:'verified',feature:'booking',purpose:'member',mode:'inherit',expectedVersion:1,requestId:crypto.randomUUID()})}));return{status:r.status,body:await r.json()};};
  const rejected=await save();assert.equal(rejected.body.error.code,'LINE_NOTIFICATION_INVALID',JSON.stringify(rejected));
  assert.equal((await h.db.query('select count(*)::int n from platform_private.module_notification_routes')).rows[0].n,0);
  valid=true;const saved=await save();assert.equal(saved.status,200,JSON.stringify(saved));
  assert.equal(saved.body.data.tenant.moduleLine.booking.notifications.member.channelId,'2010123456');assert.ok(saved.body.data.tenant.moduleLine.booking.notifications.member.verifiedAt);
  assert.equal(provider.length,2);assert.equal((await h.rpc('platform_module_credentials',{p_tenant_id:h.tenant.id,p_feature:'booking'})).data.scope,'tenant');
 }finally{await h.db.close();}
});
test('#124 Messaging credential saves verify token ownership before encrypting or advancing a module version',async()=>{
 const h=await setup();try{
  const {createPlatformHandler}=await import('../../supabase/functions/_shared/platform-handler.mjs');let valid=false;
  const handler=createPlatformHandler({db:{rpc:h.rpc},allowedOrigins:h.allowedOrigins,encryptionKey:()=>key,verifyApplicantIdentity:async()=>({lineUserId:owner,issuedAtMs:Date.now()}),verifyIdentity:()=>assert.fail('merchant scope required'),fetchImpl:async(url)=>{assert.equal(url,'https://api.line.me/v2/oauth/verify');return new Response(JSON.stringify({client_id:valid?'2010123456':'2010999999',expires_in:3600}));}});
  const save=async()=>{const response=await handler(new Request('https://backend.test',{method:'POST',body:JSON.stringify({action:'platform.line.save',business:h.tenant.slug,idToken:'verified',feature:'booking',expectedVersion:1,requestId:crypto.randomUUID(),line:lineFor('booking',{messagingChannelId:'2010123456'}),credentials:{channelAccessToken:'synthetic-module-verified-token-123456',channelSecret:'a'.repeat(32)}})}));return {status:response.status,body:await response.json()};};
  const rejected=await save();assert.equal(rejected.status,400,JSON.stringify(rejected));assert.equal(rejected.body.error.code,'LINE_NOTIFICATION_INVALID');
  assert.equal((await h.db.query('select count(*)::int n from platform_private.module_secrets')).rows[0].n,0);
  assert.equal((await h.db.query('select version from platform_private.tenants')).rows[0].version,1);
  valid=true;const accepted=await save();assert.equal(accepted.status,200);assert.equal(accepted.body.data.tenant.moduleLine.booking.credentialsConfigured,true);
 }finally{await h.db.close();}
});
