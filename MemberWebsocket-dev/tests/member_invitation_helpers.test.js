const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const shared=n=>import(pathToFileURL(path.resolve(__dirname,'../supabase/functions/_shared',n)).href);
const tenant={id:'tenant-a',slug:'shop-a',features:{membership:true},line_config:{memberChannelId:'2010787602',memberLiffId:'2010787602-MEMBER'}};
test('INV01: 256-bit random tokens, hash-only RPC boundary, trusted tenant URL',async()=>{
 const h=await shared('member-invitations.mjs');
 const a=await h.mintInvitationToken(),b=await h.mintInvitationToken();
 assert.match(a.token,/^[a-f0-9]{64}$/);assert.match(a.hash,/^[a-f0-9]{64}$/);assert.notEqual(a.token,a.hash);assert.notEqual(a.token,b.token);
 assert.equal(await h.hashInvitationToken(a.token),a.hash);
 const url=new URL(h.invitationUrl(tenant,'2010787602',a.token));
 assert.equal(url.origin,'https://liff.line.me');assert.equal(url.pathname,'/2010787602-MEMBER');assert.equal(url.searchParams.get('business'),'shop-a');assert.equal(url.searchParams.get('invitation'),a.token);
 for(const token of [null,{},[],123,'a'.repeat(63),'a'.repeat(65),'A'.repeat(64),' '+a.token])await assert.rejects(h.hashInvitationToken(token),e=>e.code==='INVITATION_TOKEN_INVALID');
 for(const t of [null,{...tenant,slug:''},{...tenant,features:{membership:false}},{...tenant,line_config:{...tenant.line_config,memberLiffId:'2019999999-MEMBER'}}])assert.throws(()=>h.invitationUrl(t,'2010787602',a.token),e=>e.code==='INVITATION_CONFIG_INCOMPLETE');
});
test('INV02: OA guidance shares trusted binding and never blocks existing active bootstrap',async()=>{
 const {memberOaGuidance,strictLineAccessToken}=await shared('member-oa-registration-gate.mjs');
 const args={tenant,member:{membership_status:'pending'},expectedChannelId:'2010787602',verifiedBindingsJson:JSON.stringify([{tenantId:tenant.id,memberLoginChannelId:'2010787602',memberOaId:'@shop-a'}])};
 assert.deepEqual(memberOaGuidance(args),{required:true,configured:true,addFriendUrl:'https://line.me/R/ti/p/%40shop-a'});
 assert.deepEqual(memberOaGuidance({...args,verifiedBindingsJson:''}),{required:true,configured:false});
 assert.deepEqual(memberOaGuidance({...args,tenant:null,member:{membership_status:'active'},verifiedBindingsJson:''}),{required:false,configured:false});
 for(const value of [undefined,null,{},[],12,'','a'.repeat(4097)])assert.throws(()=>strictLineAccessToken(value),e=>e.code==='LINE_ACCESS_TOKEN_REQUIRED');
 assert.equal(strictLineAccessToken('token'),'token');
});
