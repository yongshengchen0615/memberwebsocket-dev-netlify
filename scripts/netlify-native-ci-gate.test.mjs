import test from 'node:test';
import assert from 'node:assert/strict';
import { isNativeVerifiedPreview, awaitVerifiedPreviewCI, NativeCiGateError } from './netlify-native-ci-gate.mjs';

const sha='b'.repeat(40), branch='Integrated-Marketing-Platform';
const required=['test-memberwebsocket-dev.yml','test-netlify-build.yml','test-memberwebsocket-ticket-policy.yml'];
const rows=(status='completed', conclusion='success')=>required.map((file,i)=>({
 id:i+1,event:'push',head_branch:branch,head_sha:sha,path:`https://github.com/owner/repo/.github/workflows/${file}`,
 status,conclusion
}));
function provider(sequence){
  const calls=[];return {calls,fetchImpl:async(url,opts)=>{
    calls.push({url,opts});
    const value=sequence[Math.min(calls.length-1,sequence.length-1)];
    return {status:value.status||200,json:async()=>value.body||{workflow_runs:value.rows}};
  }};
}
const rejects=(promise,code)=>assert.rejects(promise,error=>error instanceof NativeCiGateError&&error.code===code);
test('branch builds are released only for exact native branch context',()=>{
 assert.equal(isNativeVerifiedPreview({NETLIFY:'true',BRANCH:branch,CONTEXT:'branch-deploy'}),true);
 for(const env of [{NETLIFY:'true',BRANCH:branch,CONTEXT:'production'},
 {NETLIFY:'true',BRANCH:branch,CONTEXT:'deploy-preview'},
 {NETLIFY:'true',BRANCH:'develop',CONTEXT:'branch-deploy'},
 {NETLIFY:'false',BRANCH:branch,CONTEXT:'branch-deploy'},{}])
  assert.equal(isNativeVerifiedPreview(env),false);
});
test('successful exact-SHA push baseline unlocks build, no PR-only shortcuts',async()=>{
 const p=provider([{rows:rows()}]);
 const out=await awaitVerifiedPreviewCI({sha,fetchImpl:p.fetchImpl,attempts:1});
 assert.equal(out.status,'success');assert.deepEqual(out.runIds,[1,2,3]);assert.equal(p.calls.length,1);
 const url=new URL(p.calls[0].url);
 assert.equal(url.searchParams.get('head_sha'),sha);
 assert.equal(url.searchParams.get('branch'),branch);
 assert.equal(url.searchParams.get('event'),'push');
 assert.equal(p.calls[0].opts.redirect,'error');
 assert.equal(p.calls[0].opts.method,'GET');
});
test('pending required job is waited for, once green verified same SHA',async()=>{
 const p=provider([{rows:[...rows().slice(0,2),{...rows()[2],status:'in_progress',conclusion:null}]},{rows:rows()}]);
 const delays=[];const out=await awaitVerifiedPreviewCI({sha,fetchImpl:p.fetchImpl,attempts:2,delay:async ms=>delays.push(ms),delayMs:100});
 assert.equal(out.status,'success');assert.deepEqual(delays,[100]);assert.equal(p.calls.length,2);
});
test('missing required CI never counts as passing',async()=>{
 const p=provider([{rows:rows().slice(0,2)}]);const waits=[];
 await rejects(awaitVerifiedPreviewCI({sha,fetchImpl:p.fetchImpl,attempts:2,delay:async ms=>waits.push(ms),delayMs:50}),'CI_NOT_COMPLETE');
 assert.deepEqual(waits,[50]);
});
test('failed or cancelled required job blocks immediately',async()=>{
 for(const conclusion of ['failure','cancelled','timed_out']){
  const p=provider([{rows:[{...rows()[0],conclusion},...rows().slice(1)]}]);
  await rejects(awaitVerifiedPreviewCI({sha,fetchImpl:p.fetchImpl,attempts:5}),'CI_REQUIRED_CHECK_FAILED');
  assert.equal(p.calls.length,1);
 }
});
test('PR event, wrong SHA or branch cannot grant a native build',async()=>{
 for(const change of [{event:'pull_request'},{head_sha:'a'.repeat(40)},{head_branch:'develop'}]){
 const p=provider([{rows:rows().map(x=>({...x,...change}))}]);
 await rejects(awaitVerifiedPreviewCI({sha,fetchImpl:p.fetchImpl,attempts:1}),'CI_NOT_COMPLETE');
 }
});
test('invalid inputs fail before any network, rate limits fail closed',async()=>{
 for(const x of [{sha:'bad'},{branch:'master'},{attempts:0},{attempts:41},{delayMs:90000}]){
  let calls=0;
  await rejects(awaitVerifiedPreviewCI({sha,fetchImpl:async()=>{calls++;},...x}),'INVALID_SOURCE');
  assert.equal(calls,0);
 }
 const p=provider([{status:403}]);
 await rejects(awaitVerifiedPreviewCI({sha,fetchImpl:p.fetchImpl,attempts:2}),'CI_PROVIDER_HTTP_403');
 assert.equal(p.calls.length,1);
});
test('malformed provider data and network error do not leak response secrets',async()=>{
 const p=provider([{body:{token:'secret-must-not-leak'}}]);
 await rejects(awaitVerifiedPreviewCI({sha,fetchImpl:p.fetchImpl,attempts:1}),'CI_INVALID_RESPONSE');
 await rejects(awaitVerifiedPreviewCI({sha,fetchImpl:async()=>{throw Error('secret!')},attempts:1}),'CI_FETCH_UNAVAILABLE');
});
