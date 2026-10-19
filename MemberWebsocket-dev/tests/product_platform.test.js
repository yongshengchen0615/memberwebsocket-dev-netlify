const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const shared = name => import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared',name)));
const root = 'U'+'1'.repeat(32);
const tenantId='10000000-0000-4000-8000-000000000001';
const encryptionKey=Buffer.alloc(32,7).toString('base64');
async function sample() {
  const {FEATURES}=await shared('platform-policy.mjs');
  return {name:'獨立商家 A',slug:'merchant-a',ownerLineUserId:'U'+'2'.repeat(32),features:Object.fromEntries(Object.keys(FEATURES).map(k=>[k,true])),
    line:{adminChannelId:'2010791619',memberChannelId:'2010787602',messagingChannelId:'2010123456',adminLiffId:'2010791619-admin',memberLiffId:'2010787602-member',pointsLiffId:'2010787602-points',eventLiffId:'2010787602-event',calendarLiffId:'2010787602-calendar',bookingLiffId:'2010787602-booking'},
    credentials:{channelAccessToken:'synthetic-access-token-123456789',channelSecret:'a'.repeat(32)}};
}
module.exports={sample,shared,root,tenantId,encryptionKey};

test('AC-002: all eight grants are explicit booleans; role, status and unknown fields cannot be smuggled',async()=>{
  const {validateTenant,FEATURES}=await shared('platform-policy.mjs');
  const input=await sample();assert.deepEqual(Object.keys(validateTenant(input).features),Object.keys(FEATURES));
  for(const extra of [{role:'super_admin'},{status:'active'},{isolation_verified_at:'2026-10-17'}])assert.throws(()=>validateTenant({...input,...extra}),/不允許/);
  for(const key of Object.keys(FEATURES)) {
    const missing=structuredClone(input);delete missing.features[key];assert.throws(()=>validateTenant(missing),/八項/);
    const string=structuredClone(input);string.features[key]='true';assert.throws(()=>validateTenant(string),/八項/);
    const disabled=structuredClone(input);disabled.features[key]=false;assert.equal(validateTenant(disabled).features[key],false);
  }
  assert.throws(()=>validateTenant({...input,features:{...input.features,unexpected:true}}),/八項/);
});
test('AC-003: enabled surfaces require matching LIFF ids; create requires both LINE credentials',async()=>{
  const {validateTenant}=await shared('platform-policy.mjs');const input=await sample();
  for(const key of ['memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId','adminLiffId']) {
    assert.throws(()=>validateTenant({...input,line:{...input.line,[key]:''}}));
    assert.throws(()=>validateTenant({...input,line:{...input.line,[key]:'9999999999-wrong'}}),/不一致/);
  }
  assert.throws(()=>validateTenant({...input,credentials:{channelAccessToken:'',channelSecret:''}}));
  assert.throws(()=>validateTenant({...input,credentials:{...input.credentials,channelSecret:'bad'}}));
  assert.throws(()=>validateTenant({...input,credentials:{...input.credentials,channelAccessToken:'x'.repeat(4001)}}));
  assert.throws(()=>validateTenant({...input,ownerLineUserId:root+'x'}));
  assert.throws(()=>validateTenant({...input,slug:'admin'}));
  const update=validateTenant({...input,credentials:{channelAccessToken:'',channelSecret:''}},false);assert.equal(update.credentials.channelAccessToken,'');
  assert.throws(()=>validateTenant({...input,credentials:{channelAccessToken:'',channelSecret:'a'.repeat(32)}},false));
});
test('AC-004: real AES-GCM encrypts independently, binds tenant id and rejects tampering/wrong key',async()=>{
  const {sealCredentials,openCredentials}=await shared('platform-crypto.mjs');const {credentials}=await sample();
  const a=await sealCredentials(tenantId,credentials,encryptionKey);const b=await sealCredentials(tenantId,credentials,encryptionKey);
  assert.notEqual(a.iv,b.iv);assert.notEqual(a.data,b.data);assert.ok(!JSON.stringify(a).includes(credentials.channelAccessToken));
  assert.deepEqual(await openCredentials(tenantId,a,encryptionKey),credentials);
  await assert.rejects(openCredentials('other-tenant',a,encryptionKey));
  await assert.rejects(openCredentials(tenantId,a,Buffer.alloc(32,9).toString('base64')));
  const tampered=Buffer.from(a.data,'base64');tampered[0]^=1;
  await assert.rejects(openCredentials(tenantId,{...a,data:tampered.toString('base64')},encryptionKey));
  for(const key of ['',Buffer.alloc(16).toString('base64'),'not-base64'])await assert.rejects(sealCredentials(tenantId,credentials,key),/金鑰/);
});
test('AC-004: response projection excludes ciphertext, actor fields and unexpected secret columns',async()=>{
  const {publicTenant}=await shared('platform-policy.mjs');const safe=publicTenant({id:tenantId,envelope:{data:'hidden'},channel_access_token:'hidden',created_by:root,credentials_configured:true});
  assert.equal(safe.credentialsConfigured,true);assert.doesNotMatch(JSON.stringify(safe),/hidden|created_by/);
});
test('AC-006: pending/suspended merchant cannot pass the future data-plane activation gate',async()=>{
  const {requireFeature,FEATURES}=await shared('platform-policy.mjs');
  for(const feature of Object.keys(FEATURES)) {
    const row={status:'active',isolation_verified_at:'2026-10-17',runtime_schema:'business_'+'1'.repeat(32),features:{[feature]:true}};
    assert.doesNotThrow(()=>requireFeature(row,feature));
    assert.throws(()=>requireFeature({...row,status:'pending_provisioning'},feature),e=>e.code==='TENANT_NOT_READY');
    assert.throws(()=>requireFeature({...row,status:'suspended'},feature),e=>e.code==='TENANT_NOT_READY');
    assert.throws(()=>requireFeature({...row,isolation_verified_at:null},feature));
    assert.throws(()=>requireFeature({...row,features:{[feature]:false}},feature),e=>e.code==='FEATURE_DISABLED');
  }
});
test('AC-001: transport denies untrusted origin, missing/malformed auth and oversized streams before a write',async()=>{
  const {createPlatformHandler}=await shared('platform-handler.mjs');const {PlatformError}=await shared('platform-policy.mjs');const calls=[];
  const handler=createPlatformHandler({db:{rpc:async(name)=>{calls.push(name);return {data:false};}},verifyIdentity:async()=>{throw new PlatformError(401,'AUTH_INVALID','登入已失效。');},encryptionKey:()=>encryptionKey,allowedOrigins:new Set(['https://allowed.test'])});
  const req=(body,origin='https://allowed.test')=>new Request('https://backend.test',{method:'POST',headers:{Origin:origin},body:typeof body==='string'?body:JSON.stringify(body)});
  assert.equal((await handler(req({idToken:'token'},'https://attacker.test'))).status,403);
  assert.equal((await handler(req({action:'platform.bootstrap'}))).status,401);
  assert.equal((await handler(req({idToken:'expired'}))).status,401);
  assert.equal((await handler(req('{'))).status,400);
  assert.equal((await handler(req('x'.repeat(32001)))).status,413);
  assert.equal((await handler(new Request('https://backend.test',{method:'OPTIONS',headers:{Origin:'https://allowed.test'}}))).status,204);
  assert.deepEqual(calls,[]);
});

test('AC-010: Lumen admin entry embeds applicant onboarding without sending users to another page',()=>{
 const fs=require('node:fs'); const html=fs.readFileSync(path.join(__dirname,'../admin/index.html'),'utf8');
 const loader=fs.readFileSync(path.join(__dirname,'../admin/productized-workspace.js'),'utf8');
 assert.ok(html.includes('id="loadingView"') && html.includes('商家管理員申請、審核狀態與已授權功能會直接在此頁面顯示'));
 assert.ok(html.includes('id="errorView"') && html.includes('產品化管理員申請與 LINE 設定會在本頁登入後顯示'));
 assert.ok(html.includes('id="productizedAdmin" class="shell" hidden'));
 assert.ok(!html.includes('href="./workspace.html"'));
 assert.ok(loader.includes("source.querySelector('#applicationWorkspace')"));
 assert.ok(loader.includes('host.replaceChildren'));
});

test('AC-020: merchant and platform use different login return storage',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const source=fs.readFileSync(path.join(__dirname,'../platform/app.js'),'utf8');
 const admin=fs.readFileSync(path.join(__dirname,'../admin/index.html'),'utf8');
 assert.match(source,/merchantEntry\?'admin-line-login-return-v1':'platform-line-login-return-v1'/);
 assert.doesNotMatch(admin,/href="\.\.\/platform\/"/);
});


test('AC-033: merchant projection separates approved LINE configuration from isolated business readiness',async()=>{
  const {publicTenant}=await shared('platform-policy.mjs');
  const row={id:tenantId,status:'pending_provisioning',features:{membership:true,points:false},credentials_configured:true,
    envelope:{data:'private'},isolation_verified_at:null,isolation_version:null};
  const pending=publicTenant(row);
  assert.equal(pending.capabilities.lineSettingsEnabled,true);
  assert.equal(pending.capabilities.dataPlaneVerified,false);
  assert.equal(pending.capabilities.grantedFeatures.membership,true);
  assert.equal(pending.capabilities.grantedFeatures.points,false);
  assert.doesNotMatch(JSON.stringify(pending),/private|envelope/);
  const suspended=publicTenant({...row,status:'suspended'});
  assert.equal(suspended.capabilities.lineSettingsEnabled,false);
  assert.equal(suspended.capabilities.dataPlaneVerified,false);
  const incomplete=publicTenant({...row,status:'active',isolation_verified_at:'2026-10-18'});
  assert.equal(incomplete.capabilities.dataPlaneVerified,false);
  const verified=publicTenant({...row,status:'active',isolation_verified_at:'2026-10-18',isolation_version:'business-v1-20261019',runtime_schema:'business_'+'1'.repeat(32)});
  assert.equal(verified.capabilities.dataPlaneVerified,true);
});

test('AC-034: privileged denial guidance identifies the review field, not a self-service grant',()=>{
 const fs=require('node:fs');
 const html=fs.readFileSync(path.join(__dirname,'../platform/index.html'),'utf8');
 const js=fs.readFileSync(path.join(__dirname,'../platform/app.js'),'utf8');
 assert.match(html,/id="platformAuthorizationNotice"[^>]*hidden[^>]*role="alert"/);
 for(const column of ['platform_private.super_admins.enabled','line_user_id','admin_id','role = admin','status = active'])assert.ok(html.includes(column),column);
 assert.match(js,/body\.error\?\.code==='PLATFORM_ADMIN_REQUIRED'&&!merchantEntry/);
 assert.match(js,/function showAuthorizationDenied\(\)/);
 assert.doesNotMatch(html,/<button[^>]*>[^<]*開通總管理員/);
});

test('AC-037: Lumen admin reuses its existing URL and hides unapproved top features',()=>{
 const fs=require('node:fs');
 const html=fs.readFileSync(path.join(__dirname,'../admin/index.html'),'utf8');
 const admin=fs.readFileSync(path.join(__dirname,'../admin/app.js'),'utf8');
 const mount=fs.readFileSync(path.join(__dirname,'../admin/productized-workspace.js'),'utf8');
 const platform=fs.readFileSync(path.join(__dirname,'../platform/app.js'),'utf8');
 assert.match(html,/id="productizedAdmin"[^>]*hidden/);
 assert.match(html,/productized-workspace\.js/);
 assert.match(admin,/await window\.ProductizedAdminShell\.mount\(\)/);
 assert.doesNotMatch(admin,/window\.location\.replace\(target\.href\)/);
 assert.match(mount,/fetch\('\.\/workspace\.html'/);
 assert.match(mount,/legacy\.hidden=true/);
 assert.match(platform,/tenant\.features\?\.\[feature\]!==true/);
});
