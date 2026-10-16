const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/member-growth-api/index.ts'),'utf8');
const code=stripTypeScriptTypes(source.slice(source.indexOf('async function referralBind('),source.indexOf('async function transferOptions(')));
function fixture(result={data:{invite_code:'BBBB000000'},error:null}) {
 const queries=[],writes=[];class ApiError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
 const query={select(v){queries.push(['select',v]);return this;},eq(k,v){queries.push([k,v]);return this;},async maybeSingle(){return result;}};
 const db={from(t){queries.push(['table',t]);return query;},async rpc(name,payload){writes.push({name,payload});return {data:{alreadyApplied:true},error:null};}};
 const context={ApiError,asText:(v,n)=>String(v??'').trim().slice(0,n),mapDatabaseError:e=>e};vm.runInNewContext(code+';this.bind=referralBind',context);
 return {queries,writes,bind:body=>context.bind(db,{lineUserId:'verified-A'},body,{is_test_account:true})};
}
test('member number is resolved server-side within the authenticated test/live boundary before canonical referral RPC',async()=>{
 const h=fixture();await h.bind({memberCode:'bbbb',requestId:'REF-SAME-001'});assert.ok(h.queries.some(([k,v])=>k==='member_code'&&v==='BBBB'));assert.ok(h.queries.some(([k,v])=>k==='is_test_account'&&v===true));assert.ok(h.queries.some(([k,v])=>k==='membership_status'&&v==='active'));
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].name,'bind_member_referral');assert.equal(h.writes[0].payload.p_invitee_line_user_id,'verified-A');assert.equal(h.writes[0].payload.p_invite_code,'BBBB000000');assert.equal(h.writes[0].payload.p_request_id,'REF-SAME-001');
});
test('legacy invite codes retain their request and idempotency contract',async()=>{const h=fixture();await h.bind({inviteCode:'BBBB000000',requestId:'REF-SAME-001'});assert.equal(h.queries.length,0);assert.equal(h.writes[0].payload.p_invite_code,'BBBB000000');});
test('invalid, unavailable and cross-scope members cannot reach a reward write',async()=>{
 for(const body of [{memberCode:'BAD?'},{memberCode:'X'.repeat(41)}]){const h=fixture();await assert.rejects(h.bind(body),e=>e.code==='INVALID_INVITE_CODE');assert.equal(h.writes.length,0);}
 const missing=fixture({data:null,error:null});await assert.rejects(missing.bind({memberCode:'BBBB'}),e=>e.code==='INVITE_CODE_NOT_FOUND');assert.equal(missing.writes.length,0);
 const failure=fixture({data:null,error:{message:'private DB error'}});await assert.rejects(failure.bind({memberCode:'BBBB'}),e=>e.code==='DATABASE_ERROR'&&!e.message.includes('private'));assert.equal(failure.writes.length,0);
});
