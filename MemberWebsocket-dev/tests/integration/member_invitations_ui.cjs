const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../..'),tick=()=>new Promise(r=>setTimeout(r,10));
async function fixture({url='https://preview.test/member/?business=shop-a',pending=false}={}){
 const dom=new JSDOM('<main id="memberPass"><div id="memberPassActions"></div></main>',{url,runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,calls=[],session={config:{memberInvitationsEnabled:true,business:'shop-a',brandName:'測試商家'},idToken:'verified'};
 const profile={lineUserId:'user-a',memberCode:'AAAA',profileComplete:!pending,membershipRequired:pending};
 w.MemberSystem={getSession:()=>session,request:async(_c,_s,_t,action,payload)=>{
  calls.push({action,payload});
  if(action==='member.invitation.create')return {invitationUrl:'https://preview.test/member/?business=shop-a&invitation='+'a'.repeat(64),expiresAt:'2026-11-04T00:00:00Z',campaign:{title:'邀請人優惠'}};
  if(action==='member.invitation.summary')return {joinedCount:2,rewardedCount:1,pendingCount:1,rewards:[]};
  if(action==='user.member.invitation.claim')return {status:'claimed'};
  return {};
 }};
 w.eval(fs.readFileSync(path.join(root,'member/member-growth.js'),'utf8'));
 w.eval(fs.readFileSync(path.join(root,'member/member-invitations.js'),'utf8'));
 w.dispatchEvent(new w.CustomEvent('member-profile-ready',{detail:{profile}}));await tick();
 return {dom,w,calls,session,profile};
}
test('new invitations use issued URLs and summary without consuming legacy reward action',async()=>{
 const {dom,w,calls}=await fixture();try{
  w.document.getElementById('openMemberReferral').click();await tick();
  assert.ok(w.document.getElementById('memberInvitationPanel'));
  assert.match(w.document.getElementById('memberInvitationSummary').textContent,/2.*1.*1/);
  let copied='';Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async value=>copied=value}});
  w.document.getElementById('copyMemberInvitation').click();await tick();
  assert.match(copied,/business=shop-a&invitation=[a-f0-9]{64}$/);
  assert.equal(calls.filter(c=>c.action==='member.invitation.create').length,1);
  assert.equal(calls.some(c=>c.action==='member.referral.bind'),false);
  assert.match(w.document.getElementById('memberInvitationStatus').textContent,/已複製/);
 }finally{dom.window.close();}
});
test('LINE picker cancellation never reports sharing or creates a reward',async()=>{
 const {dom,w,calls}=await fixture();try{
  const messages=[];w.liff={isApiAvailable:()=>true,shareTargetPicker:async(value,options)=>{messages.push({value,options});return undefined;}};
  w.document.getElementById('shareMemberInvitation').click();await tick();
  assert.equal(messages.length,1);assert.equal(messages[0].options.isMultiple,true);
  assert.match(w.document.getElementById('memberInvitationStatus').textContent,/取消/);
  assert.doesNotMatch(w.document.getElementById('memberInvitationStatus').textContent,/已分享|已送達|獲得/);
  assert.equal(calls.some(c=>/retry|bind/.test(c.action)),false);
 }finally{dom.window.close();}
});
test('a late issued invitation cannot repaint another shop and copy fallback remains visible',async()=>{
 const {dom,w,session,profile}=await fixture();try{
  let resolve;w.MemberSystem.request=async(_c,_s,_t,action)=>action==='member.invitation.create'?new Promise(r=>resolve=r):{};
  w.document.getElementById('copyMemberInvitation').click();await tick();
  session.config={...session.config,business:'shop-b'};
  w.dispatchEvent(new w.CustomEvent('member-profile-ready',{detail:{profile:{...profile,memberCode:'BBBB'}}}));
  resolve({invitationUrl:'https://preview.test/member/?business=shop-a&invitation='+'a'.repeat(64),expiresAt:'2026-11-04T00:00:00Z'});await tick();
  assert.doesNotMatch(w.document.getElementById('memberInvitationStatus').textContent,/已複製/);
  assert.equal(w.document.querySelector('#memberInvitationManualLink').value,'');
 }finally{dom.window.close();}
});
test('pending claim is authenticated, once per token and removes token from address after claim',async()=>{
 const {dom,w,calls,session,profile}=await fixture({url:'https://preview.test/member/?business=shop-a&invitation='+'b'.repeat(64),pending:true});try{
  await w.MemberInvitations.claimPending({config:session.config,idToken:session.idToken,profile});
  await w.MemberInvitations.claimPending({config:session.config,idToken:session.idToken,profile});
  const claims=calls.filter(c=>c.action==='user.member.invitation.claim');assert.equal(claims.length,1);
  assert.equal(claims[0].payload.invitationToken,'b'.repeat(64));
  assert.equal(new URL(w.location.href).searchParams.has('invitation'),false);
  assert.equal(w.document.getElementById('memberInvitationPanel'),null);
 }finally{dom.window.close();}
});

test('transient claim failure can retry; expired token is explicit and never a claimed success',async()=>{
 const {dom,w,session,profile}=await fixture({url:'https://preview.test/member/?business=shop-a&invitation='+'c'.repeat(64),pending:true});try{
  let attempts=0;w.MemberSystem.request=async()=>{attempts++;throw Object.assign(new Error('temporarily unavailable'),{code:attempts===1?'DATABASE_ERROR':'INVITATION_TOKEN_EXPIRED'});};
  await assert.rejects(w.MemberInvitations.claimPending({config:session.config,idToken:session.idToken,profile}),/temporarily/);
  const outcome=await w.MemberInvitations.claimPending({config:session.config,idToken:session.idToken,profile});
  assert.equal(outcome.claimed,false);assert.equal(outcome.reason,'INVITATION_TOKEN_EXPIRED');assert.equal(attempts,2);
  await w.MemberInvitations.claimPending({config:session.config,idToken:session.idToken,profile});assert.equal(attempts,2);
 }finally{dom.window.close();}
});
