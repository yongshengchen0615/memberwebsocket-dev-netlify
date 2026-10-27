const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const gate=import(pathToFileURL(path.resolve(__dirname,'../supabase/functions/_shared/member-oa-registration-gate.mjs')).href);
const tenant={id:'tenant-a',features:{membership:true},line_config:{memberChannelId:'2010787602',memberLiffId:'2010787602-MEMBER'}};
const identity={lineUserId:'U'+'a'.repeat(32)};
const member={membership_status:'pending'};
const linked=JSON.stringify([{tenantId:'tenant-a',memberLoginChannelId:'2010787602',memberOaId:'@oaA'}]);
const ok=(data,status=200)=>({status,ok:status>=200&&status<300,json:async()=>data});
function fixture(extra={},responses=[]){
 const calls=[];const defaults=[ok({client_id:'2010787602',scope:'openid profile',expires_in:50}),ok({userId:identity.lineUserId}),ok({friendFlag:true})];
 const fetchImpl=async(url,opts)=>{calls.push({url:String(url),opts});return responses[calls.length-1]||defaults[calls.length-1];};
 return {calls,run:async(extra2={})=>(await gate).requireMemberOaBeforeActivation({
  tenant,identity,member,expectedChannelId:'2010787602',
  lineAccessToken:'synthetic-token-do-not-store',verifiedBindingsJson:linked,fetchImpl,...extra,...extra2,
 })};
}
async function reject(promise,code,status){await assert.rejects(promise,e=>{assert.equal(e.code,code);assert.equal(e.status,status);assert.doesNotMatch(String(e.message),'synthetic-token-do-not-store');return true;});}
test('FJG02: valid linked member OA and verified access token permit first activation',async()=>{
 const h=fixture();assert.deepEqual(await h.run(),{required:true});assert.equal(h.calls.length,3);
});
test('FJG02: no server-verified binding fails closed before LINE network access',async()=>{
 const h=fixture();await reject(h.run({verifiedBindingsJson:''}),'MEMBER_OA_CONFIG_INCOMPLETE',503);assert.equal(h.calls.length,0);
});
test('FJG02: valid membership LIFF/channel configuration is required',async()=>{
 for(const broken of [
  {tenant:{...tenant,line_config:{memberChannelId:'2010787602',memberLiffId:'2010787603-BAD'}}},
  {tenant:{...tenant,line_config:{memberChannelId:'2010787603',memberLiffId:'2010787603-OK'}}},
  {tenant:{...tenant,features:{membership:false}}}
 ]){
  const h=fixture(broken);await reject(h.run(),'MEMBER_OA_CONFIG_INCOMPLETE',503);assert.equal(h.calls.length,0);
 }
});
test('FJG02: A/B merchants cannot reuse trust of another merchant or shared Login Channel',async()=>{
 const bad=JSON.stringify([{tenantId:'tenant-b',memberLoginChannelId:'2010787602',memberOaId:'@oaB'}]);
 await reject(fixture({verifiedBindingsJson:bad}).run(),'MEMBER_OA_CONFIG_INCOMPLETE',503);
 const duplicate=JSON.stringify([{tenantId:'tenant-a',memberLoginChannelId:'2010787602',memberOaId:'@oaA'},{tenantId:'tenant-b',memberLoginChannelId:'2010787602',memberOaId:'@oaB'}]);
 await reject(fixture({verifiedBindingsJson:duplicate}).run(),'MEMBER_OA_CONFIG_INCOMPLETE',503);
});
test('FJG02: forged client-supplied friendFlag cannot override LINE friendship=false',async()=>{
 const h=fixture({},[null,null,ok({friendFlag:false})]);
 await reject(h.run({friendFlag:true}),'MEMBER_OA_FRIENDSHIP_REQUIRED',403);
});
test('FJG02: LINE provider rate limit fails closed and never grants pending activation',async()=>{
 const h=fixture({},[null,null,ok({},429)]);await reject(h.run(),'LINE_FRIENDSHIP_UNAVAILABLE',503);
});
test('FJG02: existing active member does not need access token or current OA friendship',async()=>{
 const h=fixture({member:{membership_status:'active'},verifiedBindingsJson:'',lineAccessToken:''});
 assert.deepEqual(await h.run(),{required:false});assert.equal(h.calls.length,0);
});
test('FJG02: token invalid and mismatched identity/channel cannot verify membership',async()=>{
 const invalid=fixture({lineAccessToken:''});await reject(invalid.run(),'LINE_ACCESS_TOKEN_REQUIRED',401);
 const cross=fixture({},[ok({client_id:'2010787603',scope:'profile',expires_in:10})]);
 await reject(cross.run(),'LINE_CHANNEL_OR_SCOPE_MISMATCH',401);
 const other=fixture({},[null,ok({userId:'U'+'b'.repeat(32)})]);
 await reject(other.run(),'LINE_IDENTITY_MISMATCH',401);
});
