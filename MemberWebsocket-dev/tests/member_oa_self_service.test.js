const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const file=p=>fs.readFileSync(path.join(root,p),'utf8');
const load=()=>import(pathToFileURL(path.join(root,'supabase/functions/_shared/member-oa-ownership.mjs')).href);
const line={memberChannelId:'2010787602',memberLiffId:'2010787602-member',messagingChannelId:'2010770275'};
const credentials={channelAccessToken:'synthetic-secret-do-not-log'};
const bot={basicId:'@049najfx',userId:'U'+'a'.repeat(32)};
function stub({tokenChannel=line.messagingChannelId,botInfo=bot,status=200,throwNetwork=false}={}) {
 const calls=[];
 return {calls,fetchImpl:async(url,opts)=>{
   calls.push({url:String(url),method:opts.method});
   if(throwNetwork)throw Error('offline');
   if(String(url).endsWith('/v2/oauth/verify'))return new Response(JSON.stringify({client_id:tokenChannel,expires_in:3600}),{status:200});
   if(String(url).endsWith('/v2/bot/info'))return new Response(JSON.stringify(botInfo),{status});
   throw Error('unexpected endpoint');
 }};
}
test('OA-001: owner credentials reveal server-derived Basic ID without claiming LINE Login linkage',async()=>{
 const {inspectMemberOaOwnership}=await load(),client=stub();
 const data=await inspectMemberOaOwnership({line,credentials,fetchImpl:client.fetchImpl});
 assert.deepEqual(data,{memberLoginChannelId:line.memberChannelId,messagingChannelId:line.messagingChannelId,memberOaId:'@049najfx',linkedLoginVerified:false});
 assert.equal(client.calls.length,2);assert.ok(client.calls.every(call=>!call.url.includes('synthetic-secret')));
 assert.ok(!JSON.stringify(data).includes(credentials.channelAccessToken));
});
test('OA-002: incorrect Messaging Channel token must fail closed',async()=>{
 const {inspectMemberOaOwnership}=await load(),client=stub({tokenChannel:'2010123456'});
 await assert.rejects(inspectMemberOaOwnership({line,credentials,fetchImpl:client.fetchImpl}),e=>e.code==='LINE_NOTIFICATION_INVALID');
 assert.equal(client.calls.length,1);
});
test('OA-003: incomplete Login/LIFF or missing secret rejects before LINE API',async()=>{
 const {inspectMemberOaOwnership}=await load(),client=stub();
 await assert.rejects(inspectMemberOaOwnership({line:{...line,memberLiffId:'2010111111-wrong'},credentials,fetchImpl:client.fetchImpl}),e=>e.code==='MEMBER_LINE_INCOMPLETE');
 await assert.rejects(inspectMemberOaOwnership({line,credentials:{},fetchImpl:client.fetchImpl}),e=>e.code==='MEMBER_OA_TOKEN_REQUIRED');
 assert.equal(client.calls.length,0);
});
test('OA-004: malformed bot identity, outages and 5xx do not count as verified',async()=>{
 const {inspectMemberOaOwnership}=await load();
 for(const cfg of [{botInfo:{basicId:'@049najfx'}},{botInfo:{...bot,basicId:'invalid'}},{status:503},{throwNetwork:true}])
   await assert.rejects(inspectMemberOaOwnership({line,credentials,fetchImpl:stub(cfg).fetchImpl}),e=>e.status>=400);
});
test('OA-005: preview action is tenant authenticated and read-only; production remains unchanged',()=>{
 const handler=file('supabase/functions/_shared/platform-handler.mjs');
 const preview=file('supabase/functions/platform-api-preview/index.ts');
 const production=file('supabase/functions/platform-api/index.ts');
 const ui=file('admin/business-line-settings.js');
 assert.match(handler,/body.action === 'platform.member-oa.inspect'/);
 assert.match(handler,/const workspace=await mine\(\),current=workspace.tenant/);
 assert.match(handler,/current.features\?\.membership!==true/);
 assert.match(handler,/moduleCredentials\(current,'membership'\)/);
 assert.match(handler,/inspectMemberOaOwnership\(\{line,credentials,fetchImpl\}\)/);
 assert.match(preview,/allowedActions:new Set\(\['platform.member-oa.readiness','platform.member-oa.inspect'\]\)/);
 assert.doesNotMatch(production,/allowedActions:new Set\(\['platform.member-oa.readiness'/);
 assert.match(ui,/由 LINE 自動辨識我的官方帳號/);
 assert.match(ui,/Linked LINE Official Account/);
 assert.doesNotMatch(file('supabase/functions/_shared/member-oa-registration-gate.mjs'),/inspectMemberOaOwnership/);
});
