import test from 'node:test';
import assert from 'node:assert/strict';
let setReleaseMarker;
try { ({setReleaseMarker}=await import('./netlify-release-marker.mjs')); } catch(e) {if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const sha='87d3ec582d3771570aeac6b8a1e9bb61f2803ce3',key='PLATFORM_BACKEND_VERIFIED_SHA',branch='Integrated-Marketing-Platform';
const siteId='196e1d2c-8216-4ba8-aeb9-1706660adc2b';
const row=value=>({key,is_secret:false,scopes:['builds'],values:[{context:'branch',context_parameter:'Integrated-Marketing-Platform',value}]});
const site={id:siteId,name:'memberwebsocket-dev-netlify',account_slug:'yongshengchen0615',build_settings:{repo_path:'yongshengchen0615/memberwebsocket-dev-netlify',repo_branch:'master'}};
function provider({initial=null,noOp=false,wrongSite=false,writeError=false}={}) {
 let saved=initial;const calls=[];
 return {calls,get saved(){return saved;},fetch:async(url,opts)=>{
  assert.equal(opts.headers.Authorization,'Bearer secret-token');assert.equal(opts.redirect,'error');
  calls.push({url,method:opts.method,body:opts.body&&JSON.parse(opts.body)});
  if(url===`https://api.netlify.com/api/v1/sites/${siteId}`)return Response.json(wrongSite?{...site,id:'other'}:site);
  const root='https://api.netlify.com/api/v1/accounts/yongshengchen0615/env';
  if(opts.method==='GET'&&url===`${root}/${key}?site_id=${siteId}`)return saved?Response.json(saved):new Response('',{status:404});
  if(['POST','PATCH'].includes(opts.method)) {
   if(writeError)throw Error('secret-token PRIVATE_PROVIDER_BODY');
   const body=JSON.parse(opts.body);
   if(opts.method==='POST') {
    assert.equal(url,`${root}?site_id=${siteId}`);
    assert.deepEqual(body,[{key,is_secret:false,values:[{context:'branch',context_parameter:'Integrated-Marketing-Platform',value:sha}]}]);
    if(!noOp)saved={...structuredClone(body[0]),scopes:['builds','functions','post_processing','runtime']};
   }else{
    assert.equal(url,`${root}/${key}?site_id=${siteId}`);
    assert.deepEqual(body,{context:'branch',context_parameter:'Integrated-Marketing-Platform',value:sha});
    if(!noOp)saved=row(sha);
   }
   return Response.json(opts.method==='POST'?[row(sha)]:row(sha),{status:201});
  }
  throw Error('Unexpected request '+url);
 }};
}
async function run(p,extra={}) {
 assert.equal(typeof setReleaseMarker,'function','release marker must persist and read back the provider value');
 return setReleaseMarker({branch,sha,key,token:'secret-token',fetchImpl:p.fetch,...extra});
}
test('AC-015 creates a canonical branch marker and verifies persisted value',async()=>{
 const p=provider();const result=await run(p);assert.equal(result.status,'marker-verified');assert.equal(result.sha,sha);
 assert.deepEqual(p.calls.map(x=>x.method),['GET','GET','POST','GET']);assert.equal(p.saved.values[0].value,sha);assert.doesNotMatch(JSON.stringify(result),/secret-token|PRIVATE/);
});
test('AC-015 updates only the existing branch value and is idempotent',async()=>{
 const p=provider({initial:row('a'.repeat(40))});await run(p);assert.deepEqual(p.calls.map(x=>x.method),['GET','GET','PATCH','GET']);
 const same=provider({initial:row(sha)});await run(same);assert.deepEqual(same.calls.map(x=>x.method),['GET','GET']);
});
test('AC-015 success response without persisted marker cannot unlock a native build',async()=>{
 for(const initial of [null,row('a'.repeat(40))]){const p=provider({initial,noOp:true});await assert.rejects(run(p),/MARKER_READBACK_MISMATCH/);assert.equal(p.calls.filter(x=>['POST','PATCH'].includes(x.method)).length,1);}
});
test('AC-015 refuses unexpected scopes, production/all contexts, hidden values and wrong site before writes',async()=>{
 const invalid=[{...row(sha),scopes:['builds','functions']},{...row(sha),is_secret:true},{...row(sha),key:'OTHER'},
 {...row(sha),values:[{context:'all',value:sha}]},{...row(sha),values:[{context:'production',value:sha}]},
 {...row(sha),values:[{context:'branch',context_parameter:'master',value:sha}]},
 {...row(sha),scopes:['builds','functions','post_processing','runtime'],values:[{context:'production',value:sha}]},
 {...row(sha),scopes:['builds','functions','post_processing','runtime'],values:[{context:'all',value:sha}]}];
 for(const initial of invalid){const p=provider({initial});await assert.rejects(run(p),/MARKER_SCOPE_INVALID/);assert.ok(p.calls.every(x=>x.method==='GET'));}
 const p=provider({wrongSite:true});await assert.rejects(run(p),/MARKER_SITE_INVALID/);assert.equal(p.calls.length,1);
});
test('AC-015 rejects unauthorized branch/key/SHA or missing credential without provider calls',async()=>{
 for(const extra of [{branch:'master'},{branch:'integrated-marketing-platform'},{sha:'bad'},{token:''},{key:'NETLIFY_AUTH_TOKEN'}]){const p=provider();await assert.rejects(run(p,extra),/MARKER_INPUT_INVALID/);assert.equal(p.calls.length,0);}
});
test('AC-015 unknown write outcomes are never retried and diagnostic errors hide credentials',async()=>{
 const p=provider({writeError:true});await assert.rejects(run(p),e=>/MARKER_WRITE_OUTCOME_UNKNOWN/.test(e.message)&&!/secret|PRIVATE/.test(e.message));assert.equal(p.calls.filter(x=>x.method==='POST').length,1);
});

test('AC-016 current plan can persist public branch attestations without paid granular scopes',async()=>{
 let saved=null;let writes=0;
 const fetchImpl=async(url,options)=>{
  if(url.endsWith('/sites/'+siteId))return Response.json(site);
  if(options.method==='GET')return saved?Response.json(saved):new Response('',{status:404});
  writes++;
  const body=JSON.parse(options.body)[0];
  if(body.scopes)return new Response('Setting scopes requires an upgrade',{status:403});
  saved={...body,scopes:['builds','functions','post_processing','runtime']};
  return Response.json([saved],{status:201});
 };
 assert.equal(typeof setReleaseMarker,'function');
 const result=await setReleaseMarker({branch,sha,key,token:'secret-token',fetchImpl});
 assert.equal(result.status,'marker-verified');assert.equal(writes,1);
 assert.deepEqual(saved.values,[{context:'branch',context_parameter:'Integrated-Marketing-Platform',value:sha}]);
 assert.equal(saved.is_secret,false);
});

test('AC-017 the exact Git branch can consume the persisted release marker',async()=>{
 let saved=null;
 const fetchImpl=async(url,options)=>{
  if(url.endsWith('/sites/'+siteId))return Response.json(site);
  if(options.method==='GET')return saved?Response.json(saved):new Response('',{status:404});
  saved={...JSON.parse(options.body)[0],scopes:['builds','functions','post_processing','runtime']};
  return Response.json([saved],{status:201});
 };
 await setReleaseMarker({branch,sha,key,token:'secret-token',fetchImpl});
 // Characterize the observed native consumer: custom-branch context matching
 // is case-sensitive even though the CLI normalizes its branch input.
 const consumed=saved.values.find(v=>v.context==='branch'&&v.context_parameter===branch)?.value;
 assert.equal(consumed,sha,'the case-preserved Git branch must receive the attestation');
});
