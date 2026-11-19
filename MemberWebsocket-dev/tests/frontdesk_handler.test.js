const {test}=require('node:test'),assert=require('node:assert/strict');
test('frontdesk API verifies trusted audience, ignores forged identity and blocks unknown actions',async()=>{
 const {createFrontdeskHandler}=await import('../supabase/functions/_shared/frontdesk-handler.mjs');
 const calls=[],actor='U'+'4'.repeat(32),context={id:'10000000-0000-4000-8000-000000000001',slug:'shop-a',name:'A',features:{booking:true,frontdesk:true},frontdesk:{enabled:true,loginChannelId:'2010999999',liffId:'2010999999-desk',oaId:'@desk'}};
 const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name==='platform_frontdesk_context'?context:name==='consume_api_rate_limit'?true:{staff:{status:'approved',permissionMode:'notify_only'}},error:null};}};
 const handler=createFrontdeskHandler({db,allowedOrigins:new Set(['https://allowed.test']),verifyIdentity:async(token,channel)=>{assert.equal(channel,'2010999999');if(token!=='valid')throw {status:401,code:'AUTH_INVALID',message:'invalid'};return{lineUserId:actor,issuedAtMs:Date.now()};}});
 const call=async(body,origin='https://allowed.test')=>{const r=await handler(new Request('https://api.test',{method:'POST',headers:{Origin:origin},body:JSON.stringify({business:'shop-a',idToken:'valid',...body})}));return {status:r.status,body:await r.json()};};
 assert.equal((await call({action:'frontdesk.bootstrap',actor:'U'+'f'.repeat(32),role:'admin'})).status,200);
 assert.equal(calls.find(c=>c.name==='platform_frontdesk_request').args.p_actor,actor);
 assert.equal((await call({action:'admin.booking.status.update'})).status,400);
 assert.equal((await call({action:'frontdesk.bootstrap',idToken:'wrong'})).status,401);
 const n=calls.length;assert.equal((await call({action:'frontdesk.bootstrap'},'https://evil.test')).status,403);assert.equal(calls.length,n);
});
test('frontdesk notification never inherits a member/admin token',async()=>{
 const {notificationToken}=await import('../supabase/functions/_shared/notification-routes.mjs');
 assert.equal(notificationToken({credentials:{channelAccessToken:'other-token'}},'frontdesk'),'');
 assert.equal(notificationToken({notificationCredentials:{frontdesk:'desk-token'}},'frontdesk'),'desk-token');
});
test('merchant can disable a configured frontdesk without re-entering its secret',async()=>{
 const {frontdeskAdmin}=await import('../supabase/functions/_shared/frontdesk-admin.mjs');const calls=[];
 const result=await frontdeskAdmin({db:{rpc:async(name,args)=>{calls.push({name,args});return {data:name==='platform_frontdesk_replay'?null:{frontdesk:{enabled:false}},error:null};}},body:{action:'platform.frontdesk.settings.save',requestId:crypto.randomUUID(),expectedVersion:2,settings:{loginChannelId:'2010999999',liffId:'2010999999-desk',messagingChannelId:'2010888888',enabled:false},channelAccessToken:''},actor:'U'+'4'.repeat(32),issuedAt:new Date().toISOString(),tenant:{id:'10000000-0000-4000-8000-000000000001',features:{booking:true,frontdesk:true}},fetchImpl:()=>assert.fail('disable never contacts LINE'),encryptionKey:()=>assert.fail('disable preserves existing ciphertext')});
 assert.equal(result.frontdesk.enabled,false);assert.equal(calls.at(-1).args.p_body.envelope,null);
});
