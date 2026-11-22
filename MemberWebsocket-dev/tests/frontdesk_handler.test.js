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
 const bypassCount=calls.length;
 const bypass=await call({action:'frontdesk.booking.update',bookingId:'10000000-0000-4000-8000-000000000011',
  status:'rejected',rejectionReason:'unrecorded_phone_booking',requestId:'10000000-0000-4000-8000-000000000012',
  expectedUpdatedAt:'2026-11-22T00:00:00Z'});
 assert.equal(bypass.status,400,'direct reject cannot bypass paired on-site overlap validation');
 assert.equal(bypass.body.error.code,'FRONTDESK_USE_PAIRED_REJECTION');
 assert.equal(calls.length,bypassCount,'bypassed action must never reach the database');
 assert.equal((await call({action:'frontdesk.bootstrap',idToken:'wrong'})).status,401);
 const n=calls.length;assert.equal((await call({action:'frontdesk.bootstrap'},'https://evil.test')).status,403);assert.equal(calls.length,n);
});

test('AC-FD-LINE-003: history accepts an optional UUID and passes single-booking scope to the authorized RPC',async()=>{
 const {createFrontdeskHandler}=await import('../supabase/functions/_shared/frontdesk-handler.mjs');
 const bookingId='10000000-0000-4000-8000-000000000011',calls=[];
 const context={id:'10000000-0000-4000-8000-000000000001',slug:'shop-a',frontdesk:{enabled:true,loginChannelId:'2010999999'}};
 const db={rpc:async(name,args)=>{
  calls.push({name,args});
  return {data:name==='consume_api_rate_limit'?true:name==='platform_frontdesk_context'?context:{items:[{booking:{id:bookingId}}]},error:null};
 }};
 const handler=createFrontdeskHandler({db,allowedOrigins:new Set(['https://allowed.test']),verifyIdentity:async token=>{
  if(token!=='valid')throw {status:401,code:'AUTH_INVALID',message:'Invalid LINE identity'};
  return {lineUserId:'U'+'4'.repeat(32),issuedAtMs:Date.now()};
 }});
 const call=async body=>{const r=await handler(new Request('https://api.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({action:'frontdesk.history',business:'shop-a',idToken:'valid',...body})}));return {status:r.status,data:await r.json()};};
 let result=await call({bookingId});
 assert.equal(result.status,200);assert.equal(result.data.data.items[0].booking.id,bookingId);
 assert.equal(calls.at(-1).name,'platform_frontdesk_request');
 assert.equal(calls.at(-1).args.p_action,'history');
 assert.equal(calls.at(-1).args.p_body.bookingId,bookingId);
 const count=calls.length;
 result=await call({bookingId:'bad-booking-id'});
 assert.equal(result.status,400);assert.equal(result.data.error.code,'PLATFORM_INVALID_INPUT');
 assert.equal(calls.length,count,'invalid IDs must be rejected before identity and DB access');
 result=await call({idToken:'forged',bookingId});
 assert.equal(result.status,401);
 assert.equal(calls.filter(x=>x.name==='platform_frontdesk_request').length,1);
 result=await call({});
 assert.equal(result.status,200);assert.equal(calls.at(-1).args.p_action,'history');
 assert.equal(calls.at(-1).args.p_body.bookingId,undefined,'ordinary frontdesk history stays unscoped');
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

test('merchant-scoped frontdesk deletion validates payload and does not contact LINE',async()=>{
 const {frontdeskAdmin}=await import('../supabase/functions/_shared/frontdesk-admin.mjs');
 const calls=[],tenant={id:'10000000-0000-4000-8000-000000000001',features:{booking:true,frontdesk:true}};
 const args={db:{rpc:async(name,input)=>{calls.push({name,input});return{data:name==='platform_frontdesk_replay'?null:{staff:[]},error:null};}},actor:'U'+'4'.repeat(32),tenant,issuedAt:new Date().toISOString(),fetchImpl:()=>assert.fail('delete never contacts LINE'),encryptionKey:()=>assert.fail('delete never decrypts secrets')};
 const staffId=crypto.randomUUID(),requestId=crypto.randomUUID();
 const result=await frontdeskAdmin({...args,body:{action:'platform.frontdesk.staff.delete',staffId,expectedVersion:2,requestId}});
 assert.deepEqual(result.staff,[]);
 assert.equal(calls.at(-1).input.p_action,'staff.delete');
 assert.equal(calls.at(-1).input.p_body.staffId,staffId);
 assert.match(calls.at(-1).input.p_body.payloadHash,/^[0-9a-f]{64}$/);
 await assert.rejects(()=>frontdeskAdmin({...args,body:{action:'platform.frontdesk.staff.delete',staffId,expectedVersion:2,requestId,status:'approved'}}),/移除人員資料不正確/);
 await assert.rejects(()=>frontdeskAdmin({...args,body:{action:'platform.frontdesk.staff.delete',staffId,expectedVersion:2,requestId,permissionMode:'review'}}),/移除人員資料不正確/);
 await assert.rejects(()=>frontdeskAdmin({...args,tenant:{...tenant,features:{booking:true,frontdesk:false}},body:{action:'platform.frontdesk.staff.delete',staffId,expectedVersion:2,requestId}}),/尚未開通/);
});
