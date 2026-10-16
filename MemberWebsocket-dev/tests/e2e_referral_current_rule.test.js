const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function runner(mode={}) {
  const calls=[],deleted=[];let seq=0;
  const context={window:{addEventListener(){},MemberSystem:{request:async(_c,_t,_k,action)=>{calls.push(action);return action==='admin.event-tickets.list'?{eventTickets:mode.existing?[{ticketType:'referral',status:'active'}]:[]}:{deleted:true};}}},document:{},performance,console};
  const source=fs.readFileSync(path.join(__dirname,'../admin/e2e-control.js'),'utf8').replace('  window.MemberAdminE2EControl =',`  window.qa={run:pairedMemberReferralRewardCase,mock(m){createEphemeralTestAccount=m.create;prepareEphemeralConsents=m.consents;createPairedSession=m.login;adminSession=m.admin;memberGrowthRequest=m.growth;userEventBootstrap=m.event;postFunction=m.post;removeEphemeralTestAccount=m.remove;}};\n  window.MemberAdminE2EControl =`);
  vm.runInNewContext(source,context);const qa=context.window.qa;let title='';
  qa.mock({create:async()=>({memberId:'m'+(++seq),memberCode:'CODE'+seq,lineUserId:'test:m'+seq}),consents:async()=>({currentConsentCount:3}),login:async account=>({testSessionToken:account.memberId}),admin:async()=>({config:{},idToken:'fixture'}),
    post:async(_slug,body)=>{if(body.action==='admin.event-tickets.save'){title=body.eventTicket.title;return {eventTicket:{eventTicketId:'QA-SOURCE'}};}if(body.action==='user.member.bootstrap')return {profile:{inviteCode:'ABCD012345'}};throw new Error('Unknown fixture action '+body.action);},
    growth:async(login,_type,action,p)=>{calls.push({login,action,p});return {referralId:p.memberCode?'R2':'R1',rewardEventTicketId:p.memberCode?'E2':'E1',alreadyApplied:typeof calls.filter==='function'&&calls.filter(c=>c.action===action&&!c.p.memberCode).length===2&&!p.memberCode};},
    event:async login=>({offers:(login.testSessionToken==='m2'||mode.both?['E1','E2']:[]).map(id=>({ticket:{eventTicketId:id,title},claim:{status:'available'},canUse:false}))}),
    remove:async account=>{deleted.push(account.memberId);return !mode.cleanupFailure;}
  });return {qa,calls,deleted};
}
test('paired referral accepts caller-only two distinct rewards even before a confirmed booking',async()=>{
  const r=runner();const result=await r.qa.run();assert.equal(result.status,'passed',JSON.stringify(result));assert.deepEqual(r.deleted,['m3','m2','m1']);assert.equal(r.calls.filter(c=>c.action==='member.referral.bind').every(c=>c.login.testSessionToken==='m2'),true);
});
test('obsolete both-party rewards fail, and fixture cleanup failures cannot report a pass',async()=>{
  assert.equal((await runner({both:true}).qa.run()).status,'failed');await assert.rejects(runner({cleanupFailure:true}).qa.run(),e=>e.code==='E2E_FIXTURE_CLEANUP_FAILED');
});
test('an existing active referral source blocks isolated run before creating accounts or claiming',async()=>{
  const r=runner({existing:true});assert.equal((await r.qa.run()).status,'skipped');assert.deepEqual(r.deleted,[]);assert.deepEqual(r.calls,['admin.event-tickets.list']);
});
