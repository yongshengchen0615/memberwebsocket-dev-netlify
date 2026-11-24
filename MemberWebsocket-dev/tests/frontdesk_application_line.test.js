const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const base=path.resolve(__dirname,'..');
const staff={id:'10000000-0000-4000-8000-000000000013',displayName:'櫃檯 A',status:'pending'};
const actor='U'+'a'.repeat(32);
const load=()=>import('../supabase/functions/_shared/frontdesk-application-line.mjs');
test('AC-001: new application sends bounded merchant-scoped LINE message with stable retry key',async()=>{
 const {sendFrontdeskApplicationLineMessage}=await load();const calls=[];
 const res=await sendFrontdeskApplicationLineMessage({staff,actor,merchantName:'商家 A',channelAccessToken:'server-only-secret',fetchImpl:async(url,init)=>{calls.push({url,init});return {ok:true,status:200};}});
 assert.deepEqual(res,{status:'sent'});assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://api.line.me/v2/bot/message/push');
 const {headers,body}=calls[0].init;
 assert.equal(headers['X-Line-Retry-Key'],staff.id);
 assert.equal(headers.Authorization,'Bearer server-only-secret');
 const payload=JSON.parse(body);assert.equal(payload.to,actor);
 assert.match(payload.messages[0].text,/櫃檯人員權限申請/);assert.match(payload.messages[0].text,/商家 A/);assert.match(payload.messages[0].text,/櫃檯 A/);
 assert.doesNotMatch(body,/server-only-secret|idToken|line_user_id/);
 assert.ok(payload.messages[0].text.length<1000);
});
test('AC-002: invalid status, identity or credentials cannot send',async()=>{
 const {sendFrontdeskApplicationLineMessage}=await load();
 for(const entry of [{staff:{...staff,status:'approved'}},{staff:{...staff,id:'not-a-uuid'}},{actor:'not-line-id'},{channelAccessToken:''}]){
  assert.deepEqual(await sendFrontdeskApplicationLineMessage({staff,actor,merchantName:'商家 A',channelAccessToken:'valid-token',fetchImpl:()=>assert.fail('must not send'),...entry}),{status:'not_applicable'});
 }
});
test('AC-003: provider 429/network failure does not invalidate committed application',async()=>{
 const {sendFrontdeskApplicationLineMessage}=await load();
 for(const fetchImpl of [async()=>({ok:false,status:429}),async()=>{throw Error('network')}])
  assert.deepEqual(await sendFrontdeskApplicationLineMessage({staff,actor,merchantName:'商家 A',channelAccessToken:'valid-token',fetchImpl}),{status:'failed'});
});
test('AC-004: LINE accepted replay counts as sent; unrelated conflict does not',async()=>{
 const {sendFrontdeskApplicationLineMessage}=await load();
 const run=fetchImpl=>sendFrontdeskApplicationLineMessage({staff,actor,merchantName:'商家 A',channelAccessToken:'valid-token',fetchImpl});
 assert.deepEqual(await run(async()=>({ok:false,status:409,headers:{get:key=>key==='x-line-accepted-request-id'?'accepted-id':null}})),{status:'sent'});
 assert.deepEqual(await run(async()=>({ok:false,status:409,headers:{get:()=>null}})),{status:'failed'});
});
test('AC-005: fallback chat link uses configured OA and not client-supplied recipients',async()=>{
 const {frontdeskApplicationChatLink}=await load();
 const link=frontdeskApplicationChatLink({oaId:'@desk.abc',merchantName:'商家 A',applicant:'櫃檯 A'});
 assert.ok(link.startsWith('https://line.me/R/oaMessage/%40desk.abc/?'));
 assert.match(decodeURIComponent(link),/櫃檯人員權限申請/);
 assert.equal(frontdeskApplicationChatLink({oaId:'@evil/..',merchantName:'A',applicant:'B'}),null);
});
test('AC-006: handler dispatches only after the SQL application is committed',()=>{
 const source=readFileSync(path.join(base,'supabase/functions/_shared/frontdesk-handler.mjs'),'utf8');
 assert.match(source,/sendFrontdeskApplicationLineMessage/);
 assert.match(source,/const data=await rpc\([^\n]*'platform_frontdesk_request'/);
 assert.ok(source.indexOf('const data=await rpc(')<source.indexOf('await sendFrontdeskApplicationLineMessage('));
 assert.match(source,/lineApplicationMessage/);
});
test('AC-007: frontend retains application and explains LINE provider failure',()=>{
 const source=readFileSync(path.join(base,'frontdesk/app.js'),'utf8');
 assert.match(source,/result\.lineApplicationMessage==='failed'/);
 assert.match(source,/line\.me\/R\/oaMessage\//);
});
