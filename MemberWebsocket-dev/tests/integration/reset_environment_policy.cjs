const test=require('node:test');
const assert=require('node:assert/strict');
const {validateApprovalEnvironment,verifyFromGithub}=require('./verify_reset_environment.cjs');
const validContext={repository:'yongshengchen0615/memberwebsocket-dev-netlify',actor:'yongshengchen0615',ref:'refs/heads/main'};
const validEnvironment={
 name:'memberwebsocket-dev-reset',
 can_admins_bypass:false,
 protection_rules:[{
   type:'required_reviewers',prevent_self_review:true,
   reviewers:[{type:'User',reviewer:{login:'independent-reviewer'}}]
 }]
};
test('AC-CLR-032: independent reviewer, prevention of self-review and disabled admin bypass all required',()=>{
 const valid=validateApprovalEnvironment(validEnvironment,validContext);
 assert.equal(valid.hasIndependentReviewer,true);
 assert.equal(valid.allowAdminBypass,false);
 const invalid=[
  [{...validEnvironment,can_admins_bypass:true},/RESET_ADMIN_BYPASS/],
  [{...validEnvironment,can_admins_bypass:undefined},/RESET_ADMIN_BYPASS/],
  [{...validEnvironment,protection_rules:[]},/RESET_INDEPENDENT_REVIEWER/],
  [{...validEnvironment,protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:{login:'other'}}]}]},/RESET_INDEPENDENT_REVIEWER/],
  [{...validEnvironment,protection_rules:[{type:'required_reviewers',prevent_self_review:true,reviewers:[{type:'User',reviewer:{login:'yongshengchen0615'}}]}]},/RESET_INDEPENDENT_REVIEWER/],
  [{...validEnvironment,name:'production'},/RESET_PROTECTED_ENVIRONMENT/]
 ];
 for(const [environment,expected] of invalid)assert.throws(()=>validateApprovalEnvironment(environment,validContext),expected);
 for(const invalidContext of [
  {...validContext,actor:'visitor'},
  {...validContext,ref:'refs/heads/feat/issue-82-reset-preflight-safety-gate'},
  {...validContext,repository:'unrelated/project'}
 ])assert.throws(()=>validateApprovalEnvironment(validEnvironment,invalidContext));
});
test('AC-CLR-033: API must confirm environment policy; errors and unauthenticated calls fail closed',async()=>{
 const context={GITHUB_REPOSITORY:validContext.repository,GITHUB_ACTOR:validContext.actor,GITHUB_REF:validContext.ref,RESET_GITHUB_TOKEN:'synthetic-credential'};
 let calls=0;
 const fetcher=async(_url,opts)=>{
  calls++;
  assert.match(opts.headers.Authorization,/^Bearer /);
  return {ok:true,json:async()=>validEnvironment};
 };
 const result=await verifyFromGithub(context,fetcher);
 assert.equal(result.approvedEnvironment,'memberwebsocket-dev-reset');
 assert.equal(calls,1);
 await assert.rejects(verifyFromGithub({...context,RESET_GITHUB_TOKEN:''},fetcher),/RESET_GITHUB_TOKEN_REQUIRED/);
 await assert.rejects(verifyFromGithub(context,async()=>({ok:false,status:403})),/RESET_GITHUB_ENVIRONMENT_READ_FAILED/);
 await assert.rejects(verifyFromGithub(context,async()=>({ok:true,json:async()=>({...validEnvironment,protection_rules:[]})})),/RESET_INDEPENDENT_REVIEWER_REQUIRED/);
 assert.equal(calls,1);
});
