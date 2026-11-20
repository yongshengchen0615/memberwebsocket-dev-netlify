const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=location=>fs.readFileSync(path.join(__dirname,'..',location),'utf8');

test('AC-FD-RT-001: approved review staff can request a private opaque booking revision',async()=>{
 const {createFrontdeskHandler}=await import('../supabase/functions/_shared/frontdesk-handler.mjs');
 const actor='U'+'4'.repeat(32),calls=[];
 const db={rpc:async(name,args)=>{
  calls.push({name,args});
  if(name==='consume_api_rate_limit')return {data:true,error:null};
  if(name==='platform_frontdesk_context')return {data:{id:'10000000-0000-4000-8000-000000000001',slug:'shop-a',name:'A',frontdesk:{enabled:true,loginChannelId:'2010999999'}},error:null};
  if(name==='platform_frontdesk_request')return {data:{revision:'123'},error:null};
  return {data:null,error:{message:'UNEXPECTED_RPC'}};
 }};
 const handler=createFrontdeskHandler({db,allowedOrigins:new Set(['https://allowed.test']),verifyIdentity:async(id,channel)=>{
  assert.equal(id,'staff-token');assert.equal(channel,'2010999999');
  return {lineUserId:actor,issuedAtMs:Date.now()};
 }});
 const response=await handler(new Request('https://api.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({action:'frontdesk.sync.status',business:'shop-a',idToken:'staff-token',actor:'U'+'f'.repeat(32)})}));
 assert.equal(response.status,200);
 assert.deepEqual((await response.json()).data,{revision:'123'});
 const rpc=calls.find(({name})=>name==='platform_frontdesk_request');
 assert.equal(rpc.args.p_action,'sync.status');
 assert.equal(rpc.args.p_actor,actor);
 assert.equal(rpc.args.p_tenant_id,'10000000-0000-4000-8000-000000000001');
 assert.deepEqual(rpc.args.p_body,{});
});

test('AC-FD-RT-002: frontdesk sync rejects an unapproved staff member',async()=>{
 const {createFrontdeskHandler}=await import('../supabase/functions/_shared/frontdesk-handler.mjs');
 const handler=createFrontdeskHandler({db:{rpc:async(name)=>{
  if(name==='consume_api_rate_limit')return{data:true,error:null};
  if(name==='platform_frontdesk_context')return{data:{id:'10000000-0000-4000-8000-000000000001',frontdesk:{loginChannelId:'2010999999'}},error:null};
  if(name==='platform_frontdesk_request')return{data:null,error:{message:'FRONTDESK_REVIEW_REQUIRED'}};
  return{data:null,error:{message:'UNKNOWN'}};
 }},allowedOrigins:new Set(['https://allowed.test']),verifyIdentity:async()=>({lineUserId:'U'+'4'.repeat(32),issuedAtMs:Date.now()})});
 const response=await handler(new Request('https://api.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({action:'frontdesk.sync.status',business:'shop-a',idToken:'staff-token'})}));
 assert.equal(response.status,403);
 assert.equal((await response.json()).error.code,'FRONTDESK_REVIEW_REQUIRED');
});

test('AC-FD-RT-003: visibility lifecycle, revocation, and concurrency are handled by the frontdesk client',()=>{
 const app=read('frontdesk/app.js');
 assert.match(app,/async function probeSync\(/);
 assert.match(app,/request\('frontdesk\.sync\.status'\)/);
 assert.match(app,/syncInFlight\|\|busy\|\|pending\.size/);
 assert.match(app,/if\(syncRevision!==revision\)/);
 assert.match(app,/await load\(\)/);
 assert.match(app,/document\.addEventListener\('visibilitychange'/);
 assert.match(app,/window\.addEventListener\('online'/);
 assert.match(app,/stopSync\(\);failure\(error\)/);
 assert.doesNotMatch(app,/\.from\('bookings'\)/);
});

test('AC-FD-NOTIFY-001: only desk confirmation adds idempotent admin notice; member trigger remains intact',()=>{
 const sql=read('supabase/migrations/20261120143000_frontdesk_sync_admin_confirmation.sql');
 assert.match(sql,/p_action='sync\.status'/);
 assert.match(sql,/if s\.id is null or s\.status<>'approved' or s\.permission_mode<>'review'/);
 assert.match(sql,/from %I\.realtime_events where scope=''admin'' and event_type like ''booking\.%%''/);
 assert.match(sql,/if p_body->>'status'='confirmed' then[\s\S]*?notice_message:='【櫃檯確認預約】'/);
 assert.match(sql,/notice_outbox\(booking_id,event_key,channel,recipient,message_text\)/);
 assert.match(sql,/on conflict \(event_key,channel,recipient\) do nothing/);
 assert.match(sql,/'frontdesk\.confirmed:'\|\|rid::text/);
 assert.match(sql,/insert into platform_private\.requests\(request_id,actor,operation,payload_hash,result\)/);
 assert.doesNotMatch(sql,/grant .* to anon/);
 assert.doesNotMatch(sql,/create policy/);
});
