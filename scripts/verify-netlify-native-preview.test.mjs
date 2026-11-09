import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNativePreview, NativeDeployError } from './verify-netlify-native-preview.mjs';
const commit='b'.repeat(40),siteId='196e1d2c-8216-4ba8-aeb9-1706660adc2b',
  branch='Integrated-Marketing-Platform',siteName='memberwebsocket-dev-netlify',id='6ad892118bc22a8a08d1e9d5',
  old='6ad34aa232fcb1cea452346f',repo='yongshengchen0615/memberwebsocket-dev-netlify';
const source={siteId,branch,production:{branch:'master',deployId:old},build:{repository:repo}};
const native={id,site_id:siteId,branch,context:'branch-deploy',commit_ref:commit,state:'ready',
  deploy_ssl_url:'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app'};
const site={id:siteId,name:siteName,published_deploy:{id:old},build_settings:{repo_branch:'master',repo_path:repo}};
const input={commit,token:'secret-never-log',source};
const fail=(p,code)=>assert.rejects(p,x=>x instanceof NativeDeployError&&x.code===code);
function mock({items=[native],detail=native,project=site,
 aliasHTML='<html data-commit="'+commit.slice(0,7)+'"></html>'}={}){
 const calls=[];
 return {calls,fetchImpl:async(url,opts)=>{
  calls.push({url,opts});
  if(url.startsWith(native.deploy_ssl_url+'/?native_release_check=')){
   return {ok:true,status:200,text:async()=>aliasHTML};
  }
  const endpoint=new URL(url).pathname;
  const data=endpoint.endsWith('/deploys')?items:endpoint.includes('/deploys/')?detail:project;
  return {ok:true,json:async()=>data};
 }};
}
test('native exact SHA and site are accepted without any upload',async()=>{
 const m=mock(),v=await verifyNativePreview({...input,fetchImpl:m.fetchImpl,attempts:1});
 assert.equal(v.deploy_id,id);assert.equal(v.source_sha,commit);assert.equal(v.production_deploy_unchanged,true);
 assert.equal(v.deploy_url,native.deploy_ssl_url);assert.equal(m.calls.length,4);
 assert.ok(m.calls.every(x=>x.opts.method==='GET'&&x.opts.redirect==='error'));
 assert.ok(m.calls.slice(0,3).every(x=>x.opts.headers.Authorization==='Bearer secret-never-log'));
 assert.equal(m.calls[3].opts.headers.Authorization,undefined,'Public alias must never receive the Netlify token');
 assert.equal(m.calls[3].opts.cache,'no-store');
 assert.doesNotMatch(JSON.stringify(v),/secret-never-log/);
});
test('wrong SHA, PR preview, legacy Draft alias cannot satisfy native branch identity',async()=>{
 for(const patch of [{commit_ref:'a'.repeat(40)},{branch:'integrated-marketing-platform'},
 {context:'deploy-preview'},{site_id:'another'}]){
  const m=mock({items:[{...native,...patch}]});
  await fail(verifyNativePreview({...input,fetchImpl:m.fetchImpl,attempts:1}),'DEPLOY_NOT_READY');
  assert.equal(m.calls.length,1);
 }
});
test('exact commit with known native error fails closed',async()=>{
 for(const state of ['error','canceled','rejected']){
  const m=mock({items:[{...native,state}]});
  await fail(verifyNativePreview({...input,fetchImpl:m.fetchImpl,attempts:2}),'NATIVE_DEPLOY_FAILED');
  assert.equal(m.calls.length,1);
 }
});
test('bounded wait permits same-SHA native success without accepting an old alias',async()=>{
 let n=0;const waits=[];
 const m=mock();
 const out=await verifyNativePreview({...input,attempts:2,delayMs:30,
  delay:async ms=>waits.push(ms),
  fetchImpl:async(url,opts)=>{
   if(url.includes('per_page=100') && n++===0)return {ok:true,json:async()=>[{...native,commit_ref:'a'.repeat(40)}]};
   return m.fetchImpl(url,opts);
  }});
 assert.equal(out.source_sha,commit);assert.deepEqual(waits,[30]);
});
test('deploy identity, public origin and production source must remain unchanged',async()=>{
 for(const patch of [{state:'processing'},{context:'production'},{branch:'develop'},
  {commit_ref:'a'.repeat(40)},{deploy_ssl_url:'https://untrusted.example/'}]){
  const m=mock({detail:{...native,...patch}});
  await fail(verifyNativePreview({...input,fetchImpl:m.fetchImpl,attempts:1}),'DEPLOY_IDENTITY_MISMATCH');
 }
 for(const patch of [{published_deploy:{id:'changed'}},{name:'other'},
  {build_settings:{...site.build_settings,repo_branch:branch}},
  {build_settings:{...site.build_settings,repo_path:'other/repo'}}]){
  const m=mock({project:{...site,...patch}});
  await fail(verifyNativePreview({...input,fetchImpl:m.fetchImpl,attempts:1}),'PRODUCTION_IDENTITY_CHANGED');
 }
});
test('invalid input and provider failures are safely categorized, never leak secrets',async()=>{
 for(const patch of [{token:''},{commit:'broken'},{source:{...source,production:{branch,deployId:old}}},
  {source:{...source,siteId:'other'}},{attempts:0}]){
  let n=0;await assert.rejects(verifyNativePreview({...input,...patch,
    fetchImpl:async()=>{n++;}}),NativeDeployError);assert.equal(n,0);
 }
 await fail(verifyNativePreview({...input,attempts:1,fetchImpl:async()=>{throw Error('secret provider body');}}),'PROVIDER_UNAVAILABLE');
 await fail(verifyNativePreview({...input,attempts:1,fetchImpl:async()=>({ok:false,status:403})}),'PROVIDER_HTTP_403');
});

// Regression: after the publisher triggers a new native build, an older failed
// autobuild for this *same* commit must not mask the newly authorized attempt.
test('post-CI native rebuild ignores stale failed attempts but rejects a new failure',async()=>{
 const stale={...native,id:'6ad892118bc22a8a08d1e9d4',state:'error',created_at:'2026-11-08T13:26:00.000Z'};
 const fresh={...native,created_at:'2026-11-08T13:36:01.000Z'};
 const m=mock({items:[stale,fresh]});
 const result=await verifyNativePreview({...input,notBefore:'2026-11-08T13:36:00Z',fetchImpl:m.fetchImpl,attempts:1});
 assert.equal(result.deploy_id,id);
 const pending=mock({items:[stale]});
 await fail(verifyNativePreview({...input,notBefore:'2026-11-08T13:36:00Z',fetchImpl:pending.fetchImpl,attempts:1}),'DEPLOY_NOT_READY');
 const bad=mock({items:[stale,{...fresh,state:'error'}]});
 await fail(verifyNativePreview({...input,notBefore:'2026-11-08T13:36:00Z',fetchImpl:bad.fetchImpl,attempts:1}),'NATIVE_DEPLOY_FAILED');
 await fail(verifyNativePreview({...input,notBefore:'invalid-date',fetchImpl:mock().fetchImpl}),'INVALID_INPUT');
});

test('stale fixed alias blocks release even if the exact-SHA native deploy is ready',async()=>{
 const m=mock({aliasHTML:'<html data-commit="aaaaaaa"></html>'});
 await fail(verifyNativePreview({...input,fetchImpl:m.fetchImpl,attempts:1}),'NATIVE_ALIAS_STALE');
 assert.equal(m.calls.length,4);
 const alias=m.calls.at(-1);
 assert.ok(alias.url.startsWith(native.deploy_ssl_url+'/?native_release_check='+commit));
 assert.equal(alias.opts.redirect,'error');
 assert.equal(alias.opts.headers.Authorization,undefined);
});
test('stale alias eventually changes to target SHA without accepting it prematurely',async()=>{
 const m=mock(),waits=[];let checks=0;
 const out=await verifyNativePreview({...input,attempts:2,delayMs:20,
  delay:async ms=>waits.push(ms),
  fetchImpl:async(url,opts)=>{
   if(url.startsWith(native.deploy_ssl_url+'/?native_release_check=')){
    checks++;
    return {ok:true,status:200,text:async()=>checks===1?
     '<html data-commit="aaaaaaa"></html>':'<html data-commit="'+commit.slice(0,7)+'"></html>'};
   }
   return m.fetchImpl(url,opts);
  }});
 assert.equal(out.source_sha,commit);
 assert.equal(checks,2);
 assert.deepEqual(waits,[20]);
});
test('older pending native branch build cannot race over a ready release',async()=>{
 const competing={...native,id:'6ad892118bc22a8a08d1e90',state:'building',commit_ref:'a'.repeat(40)};
 const m=mock({items:[native,competing]});
 await fail(verifyNativePreview({...input,fetchImpl:m.fetchImpl,attempts:1}),'NATIVE_SIBLING_BUILD_PENDING');
 assert.equal(m.calls.length,1,'Do not accept the URL while another branch build is in flight');
 let reads=0;const waits=[];
 const stable=mock({items:[native]});
 const out=await verifyNativePreview({...input,attempts:2,delayMs:10,
  delay:async ms=>waits.push(ms),
  fetchImpl:(url,opts)=>{
   if(url.includes('per_page=100') && reads++===0)
    return Promise.resolve({ok:true,json:async()=>[native,competing]});
   // Second provider read represents the older build actually finishing.
   return stable.fetchImpl(url,opts);
  }});
 assert.equal(out.source_sha,commit);
 assert.deepEqual(waits,[10]);
});
test('public alias transport failures are not treated as a good release',async()=>{
 for(const [response,code] of [
  [{ok:false,status:503},'ALIAS_HTTP_503'],
  [{ok:true,status:200,text:async()=>{throw Error('private-error');}},'ALIAS_INVALID_HTML'],
 ]) {
  const m=mock();
  await fail(verifyNativePreview({...input,attempts:1,
   fetchImpl:(url,opts)=>url.startsWith(native.deploy_ssl_url+'/?native_release_check=')?
    Promise.resolve(response):m.fetchImpl(url,opts)}),code);
 }
 await fail(verifyNativePreview({...input,attempts:1,fetchImpl:async(url,opts)=>{
  if(url.startsWith(native.deploy_ssl_url+'/?native_release_check='))throw Error('secret-network-detail');
  return mock().fetchImpl(url,opts);
 }}),'ALIAS_UNAVAILABLE');
});
