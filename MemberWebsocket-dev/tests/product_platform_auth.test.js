const test=require('node:test'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),path=require('node:path');
const auth=()=>import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/platform-auth.mjs')));
const time=1800000000000,root='U'+'1'.repeat(32);
const claims={sub:root,name:'總管理員',aud:'2012065297',iss:'https://access.line.me',iat:time/1000-30,exp:time/1000+300};
const verify=async(payload=claims,status=200)=>{const {verifyPlatformIdToken}=await auth();return verifyPlatformIdToken({idToken:'synthetic-token',now:()=>time,fetchImpl:async()=>new Response(JSON.stringify(payload),{status})});};

test('platform LINE verification sends token to LINE with the dedicated channel and a bounded timeout',async()=>{
 const {verifyPlatformIdToken,PLATFORM_CHANNEL_ID}=await auth();let calls=0;
 const result=await verifyPlatformIdToken({idToken:'synthetic-token',now:()=>time,fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://api.line.me/oauth2/v2.1/verify');assert.equal(options.method,'POST');
  assert.equal(options.body.get('client_id'),'2012065297');assert.equal(options.body.get('id_token'),'synthetic-token');assert.ok(options.signal instanceof AbortSignal);
  return new Response(JSON.stringify(claims));
 }});
 assert.equal(PLATFORM_CHANNEL_ID,'2012065297');assert.equal(calls,1);assert.deepEqual(result,{lineUserId:root,displayName:'總管理員',issuedAtMs:claims.iat*1000});
});
test('platform rejects merchant admin/member audiences even when the LINE user is the root owner',async()=>{
 for(const aud of ['2010791619','2010787602',2012065297,['2012065297']])await assert.rejects(verify({...claims,aud}),e=>e.status===401&&e.code==='AUTH_INVALID');
});
test('platform rejects expired, future, malformed and unverified identity claims',async()=>{
 for(const patch of [{exp:time/1000},{iat:time/1000+61},{iat:0},{iat:'123'},{exp:'9999999999'},{exp:claims.iat},{iss:'https://attacker.test'},{sub:'not-a-line-user'}])await assert.rejects(verify({...claims,...patch}),e=>e.status===401);
 for(const payload of [null,[],{},'unexpected'])await assert.rejects(verify(payload),e=>e.status===401);
 await assert.rejects(verify(claims,400),e=>e.status===401);
});
test('platform fails closed on LINE service errors and never returns provider data',async()=>{
 const {verifyPlatformIdToken}=await auth();
 for(const fetchImpl of [async()=>{throw new Error('private-network-detail');},async()=>new Response('private-provider-detail'),async()=>new Response('private-provider-detail',{status:429}),async()=>new Response('private-provider-detail',{status:503})]) {
  await assert.rejects(verifyPlatformIdToken({idToken:'synthetic-token',fetchImpl}),e=>e.status===503&&e.code==='LINE_AUTH_UNAVAILABLE'&&!e.message.includes('private'));
 }
});
test('platform rejects missing or oversized tokens before contacting LINE',async()=>{
 const {verifyPlatformIdToken}=await auth();
 for(const idToken of ['',null,'x'.repeat(10001)])await assert.rejects(verifyPlatformIdToken({idToken,fetchImpl:async()=>{assert.fail('must not contact provider');}}),e=>e.status===401&&e.code==='AUTH_REQUIRED');
});
