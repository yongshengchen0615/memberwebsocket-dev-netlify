const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const channel='2010787602',user='U'+'1'.repeat(32);
const tenant={id:'tenant-a',slug:'shop-a',features:{membership:true},line_config:{memberChannelId:channel,memberLiffId:channel+'-MEMBER'}};
async function harness(endpoint,options={}){
 const invitations=await import('../supabase/functions/_shared/member-invitations.mjs');
 const oa=await import('../supabase/functions/_shared/member-oa-registration-gate.mjs');
 const member={id:'member-a',line_user_id:user,status:'active',membership_status:endpoint==='member-growth-api'?'active':'pending',created_at:'2020-01-01T00:00:00Z',...options.member};
 const calls=[],provider=[];let handler;
 const summary={joinedCount:1,rewardedCount:0,pendingCount:1,rewards:[]};
 const db={async rpc(name,args){
  calls.push({name,args});
  if(name==='consume_api_rate_limit')return{data:options.rate!==false};
  if(name==='member_service_minute_totals')return{data:[]};
  if(options.dbError)return{error:options.dbError};
  if(name==='member_invitation_create')return{data:{expiresAt:'2026-11-04T00:00:00Z',campaign:null}};
  if(name==='member_invitation_claim')return{data:{claimed:true,alreadyClaimed:false,rewardStatus:'awaiting_activation'}};
  if(['member_invitation_summary','member_invitation_retry'].includes(name))return{data:summary};
  throw Error('unexpected RPC '+name);
 },from(table){
  const row=table==='members'?member:null;
  const q={select(){return q;},eq(){return q;},update(p){Object.assign(member,p);return q;},maybeSingle:async()=>({data:row}),single:async()=>({data:row}),order:async()=>({data:[]})};return q;
 }};
 const environment={SUPABASE_URL:'https://synthetic.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic',LINE_MEMBER_CHANNEL_ID:channel,
  MEMBER_OA_VERIFIED_LINKS_JSON:JSON.stringify([{tenantId:tenant.id,memberLoginChannelId:channel,memberOaId:'@shop-a'}])};
 const fetchImpl=async url=>{provider.push(String(url));if(String(url).includes('/verify'))return Response.json({client_id:channel,scope:'profile openid',expires_in:300});if(String(url).endsWith('/profile'))return Response.json({userId:user});return Response.json({friendFlag:options.friend!==false});};
 const context=vm.createContext({...invitations,...oa,requireMemberOaBeforeActivation:args=>oa.requireMemberOaBeforeActivation({...args,fetchImpl}),
  businessEnv:key=>environment[key]||'',businessContext:()=>options.unscoped?null:tenant,serveBusiness:(_name,fn)=>{handler=fn;},createClient:()=>db,
  resolveUserTestIdentity:async()=>options.testSurface?{lineUserId:user,displayName:'Synthetic',surface:options.testSurface}:null,TestModeAuthError:class extends Error{},hasCurrentTermsConsent:async()=>options.consent!==false,
  verifyLineIdTokenContract:async args=>{if(args.idToken!=='verified')throw args.createError(401,'AUTH_INVALID','Invalid');return{lineUserId:user,displayName:'Synthetic'};},
  readJsonObject:r=>r.json(),crypto:require('node:crypto').webcrypto,TextEncoder,URL,Response,Date,console,AbortSignal});
 const source=fs.readFileSync(path.resolve(__dirname,'../supabase/functions',endpoint,'index.ts'),'utf8').replace(/^import .*\n/gm,'');
 vm.runInContext(stripTypeScriptTypes(source),context);
 return{calls,provider,member,async call(action,payload={}){const r=await handler(new Request('https://synthetic.test',{method:'POST',body:JSON.stringify({action,clientType:'member',idToken:'verified',...payload})}));return{status:r.status,headers:r.headers,body:await r.json()};}};
}
test('INV08 growth HTTP mint/summary/retry use verified actor, write budget and hash-only RPC',async()=>{
 const h=await harness('member-growth-api');
 const minted=await h.call('member.invitation.create',{lineUserId:'forged',redirectUrl:'https://evil.test'});
 assert.equal(minted.status,200,JSON.stringify(minted.body));const url=new URL(minted.body.data.invitationUrl),token=url.searchParams.get('invitation');
 assert.equal(url.host,'liff.line.me');assert.equal(url.searchParams.get('business'),'shop-a');assert.match(token,/^[a-f0-9]{64}$/);
 const call=h.calls.find(c=>c.name==='member_invitation_create');assert.equal(call.args.p_actor,user);assert.notEqual(call.args.p_token_hash,token);assert.match(call.args.p_token_hash,/^[a-f0-9]{64}$/);
 assert.equal(h.calls[0].args.p_is_write,true);assert.equal(minted.headers.get('cache-control'),'no-store');
 assert.equal((await h.call('member.invitation.summary')).body.data.pendingCount,1);assert.equal(h.calls.filter(c=>c.name==='consume_api_rate_limit').at(-1).args.p_is_write,false);
 assert.equal((await h.call('member.invitation.retry')).status,200);assert.equal(h.calls.filter(c=>c.name==='consume_api_rate_limit').at(-1).args.p_is_write,true);
});
test('INV09 new invitation HTTP actions reject unscoped, wrong client, auth/rate/consent and sanitize DB errors',async()=>{
 for(const [options,payload,status]of [[{unscoped:true},{},403],[{},{clientType:'points'},403],[{},{idToken:'bad'},401],[{rate:false},{},429],[{consent:false},{},403],[{member:{membership_status:'pending'}},{},403]]){
  const h=await harness('member-growth-api',options),r=await h.call('member.invitation.create',payload);assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(h.calls.filter(c=>c.name==='member_invitation_create').length,0);
 }
 const h=await harness('member-growth-api',{dbError:{message:'secret SQL diagnostic 123'}}),r=await h.call('member.invitation.retry');assert.equal(r.status,503);assert.equal(r.body.error.code,'INVITATION_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(r.body),/diagnostic/);
});
test('INV10 profile claim strictly validates secret; never activates or trusts caller actor/tenant',async()=>{
 const h=await harness('member-profile-api');
 for(const invitationToken of [null,{},[],123,'a'.repeat(63),'a'.repeat(65),'A'.repeat(64)]){
  const r=await h.call('user.member.invitation.claim',{invitationToken});assert.equal(r.status,400,JSON.stringify(r.body));assert.equal(r.body.error.code,'INVITATION_TOKEN_INVALID');
 }
 const r=await h.call('user.member.invitation.claim',{invitationToken:'a'.repeat(64),lineUserId:'forged',business:'other'});assert.equal(r.status,200,JSON.stringify(r.body));
 const c=h.calls.find(c=>c.name==='member_invitation_claim');assert.equal(c.args.p_actor,user);assert.notEqual(c.args.p_token_hash,'a'.repeat(64));assert.equal(h.member.membership_status,'pending');assert.equal(h.provider.length,0);
 for(const code of ['INVITATION_TOKEN_EXPIRED','INVITATION_ALREADY_CLAIMED','INVITATION_SOURCE_UNAVAILABLE']){
  const q=await harness('member-profile-api',{dbError:{message:code}}),v=await q.call('user.member.invitation.claim',{invitationToken:'a'.repeat(64)});assert.equal(v.body.error.code,code);
 }
 const q=await harness('member-profile-api',{unscoped:true});assert.equal((await q.call('user.member.invitation.claim',{invitationToken:'a'.repeat(64)})).status,403);
});
test('INV11 bootstrap safe OA guidance and server recheck never activate/accept a client friendship flag',async()=>{
 const h=await harness('member-profile-api'),b=await h.call('user.member.bootstrap');assert.deepEqual(b.body.data.memberOa,{required:true,configured:true,addFriendUrl:'https://line.me/R/ti/p/%40shop-a'});
 for(const lineAccessToken of [null,{},123,'','a'.repeat(4097)])assert.equal((await h.call('user.member.oa.check',{lineAccessToken})).status,401);
 const r=await h.call('user.member.oa.check',{lineAccessToken:'volatile'});assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.data,{memberOa:{required:true,configured:true,friend:true}});assert.equal(h.provider.length,3);assert.equal(h.member.membership_status,'pending');
 const denied=await harness('member-profile-api',{friend:false}),d=await denied.call('user.member.oa.check',{lineAccessToken:'volatile',friendFlag:true});assert.equal(d.status,403);assert.equal(d.body.error.code,'MEMBER_OA_FRIENDSHIP_REQUIRED');
 const active=await harness('member-profile-api',{member:{membership_status:'active'}});assert.deepEqual((await active.call('user.member.oa.check')).body.data,{memberOa:{required:false}});assert.equal(active.provider.length,0);
});

test('INV22 profile invitation and OA actions reject a test session issued for another surface',async()=>{
 for(const action of ['user.member.invitation.claim','user.member.oa.check']){
  const h=await harness('member-profile-api',{testSurface:'event'}),r=await h.call(action,{invitationToken:'a'.repeat(64),lineAccessToken:'volatile'});
  assert.equal(r.status,403,JSON.stringify(r.body));assert.equal(r.body.error.code,'TEST_SESSION_SURFACE_MISMATCH');assert.equal(h.calls.length,0);assert.equal(h.provider.length,0);
 }
});
