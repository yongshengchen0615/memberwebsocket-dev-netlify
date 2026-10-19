const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),{pathToFileURL}=require('node:url');
const lib=()=>import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/platform-v2-handler.mjs')));
const actor='U'+'1'.repeat(32),member='U'+'2'.repeat(32);
const tenant='10000000-0000-4000-8000-000000000001';
const requestId='30000000-0000-4000-8000-000000000003';
const flags=Object.fromEntries(['membership','points','events','calendar','integrations','booking','testing','usage'].map(k=>[k,k==='membership']));
const creds={channelAccessToken:'long-synthetic-access-token-123456789',channelSecret:'a'.repeat(32)};
const request=(data,origin='https://v2.example')=>new Request('https://v2-api.test',{method:'POST',headers:{Origin:origin,'content-type':'application/json'},body:JSON.stringify({idToken:'synthetic-id-token',...data})});
test('V2 AUTH validates LINE issuer, audience, subject, expiry and remote failures',async()=>{
 const {verifyLineIdToken}=await lib();const t=1800000000000;
 const claims={sub:actor,aud:'2012345678',iss:'https://access.line.me',iat:t/1000-60,exp:t/1000+300};
 const verify=async(payload=claims,status=200)=>verifyLineIdToken('synthetic-token',{channelId:'2012345678',now:()=>t,
   fetchImpl:async(url,opts)=>{assert.equal(url,'https://api.line.me/oauth2/v2.1/verify');assert.equal(opts.body.get('client_id'),'2012345678');return new Response(JSON.stringify(payload),{status})}});
 assert.equal((await verify()).lineUserId,actor);
 for(const patch of [{aud:'bad'},{sub:'bad'},{iss:'bad'},{exp:t/1000},{iat:t/1000+61},{exp:t/1000-1}])
   await assert.rejects(verify({...claims,...patch}),e=>e.status===401);
 await assert.rejects(verify(claims,400),e=>e.status===401);
 await assert.rejects(verifyLineIdToken('synthetic-token',{channelId:'2012345678',fetchImpl:async()=>{throw Error('private-line-error')}}),e=>e.status===503&&!e.message.includes('private'));
});
test('V2 AES-GCM envelope varies per encryption and binds tenant and feature',async()=>{
 const {sealLineCredentials}=await lib(),key=Buffer.alloc(32,9).toString('base64');
 const a=await sealLineCredentials(tenant,'membership',creds,key),b=await sealLineCredentials(tenant,'membership',creds,key);
 assert.equal(a.version,1);assert.notEqual(a.iv,b.iv);assert.notEqual(a.data,b.data);
 const decrypt=async(id,feature,e)=>{
   const k=await crypto.subtle.importKey('raw',Buffer.from(key,'base64'),'AES-GCM',false,['decrypt']);
   const p=await crypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(e.iv,'base64'),
     additionalData:new TextEncoder().encode(id+':'+feature)},k,Buffer.from(e.data,'base64'));
   return JSON.parse(new TextDecoder().decode(p));
 };
 assert.deepEqual(await decrypt(tenant,'membership',a),creds);
 await assert.rejects(decrypt(tenant,'booking',a));
 await assert.rejects(decrypt('20000000-0000-4000-8000-000000000002','membership',a));
 assert.ok(!JSON.stringify(a).includes(creds.channelAccessToken));
});
test('V2 handler denies invalid origin, body, tokens before database calls',async()=>{
 const {createPlatformV2Handler}=await lib();let dbCalls=0;
 const h=createPlatformV2Handler({db:{rpc:async()=>{dbCalls++;return {data:true,error:null}}},
   verifyIdentity:async()=>({lineUserId:member}),allowedOrigins:new Set(['https://v2.example'])});
 assert.equal((await h(request({action:'bootstrap'},'https://attacker.test'))).status,403);
 assert.equal((await h(new Request('https://v2-api.test',{method:'POST',headers:{Origin:'https://v2.example'},body:'{'}))).status,400);
 assert.equal((await h(new Request('https://v2-api.test',{method:'POST',headers:{Origin:'https://v2.example'},body:'x'.repeat(17000)}))).status,413);
 assert.equal((await h(new Request('https://v2-api.test',{method:'POST',headers:{Origin:'https://v2.example'},body:'{"action":"bootstrap"}'}))).status,400);
 assert.equal(dbCalls,0);
});
test('V2 backend ignores forged root role and tenant IDs',async()=>{
 const {createPlatformV2Handler}=await lib(),calls=[];
 const h=createPlatformV2Handler({db:{rpc:async(name,args)=>{calls.push({name,args});if(name==='v2_rate_limit')return {data:true};if(name==='v2_root_bootstrap')return {error:{message:'V2_ROOT_REQUIRED'}};return {data:{scope:'merchant'}}}},
   verifyIdentity:async()=>({lineUserId:member,displayName:'商家 A'}),allowedOrigins:new Set(['https://v2.example'])});
 const res=await h(request({action:'bootstrap',actor,role:'super_admin',tenantId:tenant}));
 assert.equal(res.status,403);assert.equal((await res.json()).error.code,'V2_ROOT_REQUIRED');
 assert.equal(calls.find(x=>x.name==='v2_root_bootstrap').args.p_actor,member);
 assert.equal((await h(request({action:'application.ensure',actor}))).status,200);
 assert.equal(calls.find(x=>x.name==='v2_ensure_application').args.p_actor,member);
});
test('V2 blocked feature and malformed credentials never trigger LINE writes',async()=>{
 const {createPlatformV2Handler}=await lib();let writes=0;
 const h=createPlatformV2Handler({db:{rpc:async name=>{
   if(name==='v2_rate_limit')return {data:true};
   if(name==='v2_merchant_bootstrap')return {data:{application:{status:'approved'},tenant:{id:tenant,status:'pending_provisioning',features:flags}}};
   if(name==='v2_save_line')writes++;return {data:{}};
 }},verifyIdentity:async()=>({lineUserId:member}),allowedOrigins:new Set(['https://v2.example']),encryptionKey:Buffer.alloc(32,1).toString('base64')});
 const draft={action:'line.save',requestId,expectedVersion:1,feature:'booking',
   config:{loginChannelId:'2011111111',liffId:'2011111111-example',messagingChannelId:'2012222222'},credentials:creds};
 assert.equal((await h(request(draft))).status,403);
 assert.equal((await h(request({...draft,feature:'membership',credentials:{channelSecret:'a'.repeat(32)}}))).status,400);
 assert.equal(writes,0);
});
test('V2 authenticated merchant encrypts credentials without response leakage',async()=>{
 const {createPlatformV2Handler}=await lib();let args;
 const h=createPlatformV2Handler({db:{rpc:async(name,p)=>{
   if(name==='v2_rate_limit')return {data:true};
   if(name==='v2_merchant_bootstrap')return {data:{application:{status:'approved'},tenant:{id:tenant,status:'pending_provisioning',features:flags}}};
   if(name==='v2_save_line'){args=p;return {data:{id:tenant,line:{membership:p.p_config}}};}
 }},verifyIdentity:async()=>({lineUserId:member}),allowedOrigins:new Set(['https://v2.example']),
 encryptionKey:Buffer.alloc(32,1).toString('base64')});
 const draft={action:'line.save',requestId,expectedVersion:1,feature:'membership',
   config:{loginChannelId:'2011111111',liffId:'2011111111-example',messagingChannelId:'2012222222'},credentials:creds};
 const res=await h(request(draft));assert.equal(res.status,200);assert.equal(args.p_actor,member);
 assert.equal(args.p_envelope.version,1);assert.equal(args.p_envelope.iv.length,16);
 const output=JSON.stringify({data:await res.json(),args});
 assert.ok(!output.includes(creds.channelAccessToken));assert.ok(!output.includes(creds.channelSecret));
});
test('V2 frontend never hard-codes old Supabase endpoint or secret keys',()=>{
 const fs=require('node:fs');
 for(const file of ['v2/index.html','v2/admin/index.html','v2/platform/index.html','v2/assets/app.js','v2/assets/client.js','v2/config.json']){
   const data=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
   assert.doesNotMatch(data,/dbuquirnaskrwcamdxki|sb_secret_|SUPABASE_SERVICE_ROLE_KEY/);
 }
 const config=JSON.parse(fs.readFileSync(path.join(__dirname,'../v2/config.json'),'utf8'));
 assert.equal(config.apiUrl,'');assert.equal(config.platformLiffId,'');
 assert.match(fs.readFileSync(path.join(__dirname,'../../scripts/build-site.mjs'),'utf8'),/'v2'/);
});
