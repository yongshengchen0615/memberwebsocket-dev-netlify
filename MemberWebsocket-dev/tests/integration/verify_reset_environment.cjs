'use strict';
const assert = require('node:assert/strict');

const REPO='yongshengchen0615/memberwebsocket-dev-netlify';
const OWNER='yongshengchen0615';
const ENVIRONMENT='memberwebsocket-dev-reset';

function validateApprovalEnvironment(environment, context) {
  assert.equal(context.repository,REPO,'RESET_REPOSITORY_MISMATCH');
  assert.equal(context.actor,OWNER,'RESET_OWNER_ONLY');
  assert.equal(context.ref,'refs/heads/main','RESET_DEFAULT_BRANCH_REQUIRED');
  assert.equal(environment?.name,ENVIRONMENT,'RESET_PROTECTED_ENVIRONMENT_MISSING');
  assert.equal(environment?.can_admins_bypass,false,'RESET_ADMIN_BYPASS_MUST_BE_DISABLED');
  const rule=(environment.protection_rules??[]).find(rule=>
    rule.type==='required_reviewers' &&
    rule.prevent_self_review===true &&
    Array.isArray(rule.reviewers) &&
    rule.reviewers.some(entry=>
      entry.type==='User' &&
      entry.reviewer?.login &&
      entry.reviewer.login.toLowerCase()!==OWNER
    )
  );
  assert.ok(rule,'RESET_INDEPENDENT_REVIEWER_REQUIRED');
  return {approvedEnvironment:ENVIRONMENT,hasIndependentReviewer:true,preventSelfReview:true,allowAdminBypass:false};
}

async function verifyFromGithub(env=process.env, fetcher=fetch) {
  const token=env.RESET_GITHUB_TOKEN;
  assert.ok(typeof token==='string'&&token.length>0,'RESET_GITHUB_TOKEN_REQUIRED');
  const context={repository:env.GITHUB_REPOSITORY,actor:env.GITHUB_ACTOR,ref:env.GITHUB_REF};
  assert.equal(context.repository,REPO,'RESET_REPOSITORY_MISMATCH');
  assert.equal(context.actor,OWNER,'RESET_OWNER_ONLY');
  assert.equal(context.ref,'refs/heads/main','RESET_DEFAULT_BRANCH_REQUIRED');
  const endpoint='https://api.github.com/repos/'+REPO+'/environments/'+ENVIRONMENT;
  const response=await fetcher(endpoint,{headers:{
    Authorization:'Bearer '+token,
    Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28',
  }});
  assert.equal(response.ok,true,'RESET_GITHUB_ENVIRONMENT_READ_FAILED');
  return validateApprovalEnvironment(await response.json(),context);
}

if(require.main===module){
  verifyFromGithub()
    .then(proof=>console.log(JSON.stringify(proof)))
    .catch(error=>{console.error('RESET_APPROVAL_GATE_FAILED:',error.message);process.exitCode=1;});
}
module.exports={validateApprovalEnvironment,verifyFromGithub};
