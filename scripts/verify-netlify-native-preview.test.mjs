import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNativePreview, NativeDeployError } from './verify-netlify-native-preview.mjs';
const commit='b'.repeat(40),siteId='196e1d2c-8216-4ba8-aeb9-1706660adc2b',
  branch='Integrated-Marketing-Platform',siteName='memberwebsocket-dev-netlify',id='6ad892118bc22a8a08d1e9d5',
  old='6ad34aa232fcb1cea452346f',repo='yongshengchen0615/memberwebsocket-dev-netlify';
const source={siteId,branch,production:{branch:'main',deployId:old},build:{repository:repo}};
const native={id,site_id:siteId,branch,context:'branch-deploy',commit_ref:commit,state:'ready',
  deploy_ssl_url:'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app'};
const site={id:siteId,name:siteName,published_deploy:{id:old},build_settings:{repo_branch:'main',repo_path:repo}};
const input={commit,token:'secret-never-log',source};
const fail=(p,code)=>assert.rejects(p,x=>x instanceof NativeDeployError&&x.code===code);
function mock({items=[native],detail=native,project=site}={}){
 const calls=[];
 return {calls,fetchImpl:async(url,opts)=>{
  calls.push({url,opts});const endpoint=new URL(url).pathname;
  const data=endpoint.endsWith('/deploys')?items:endpoint.includes('/deploys/')?detail:project;
  return {ok:true,json:async()=>data};
 }};
}
test('native exact SHA and site are accepted without any upload',async()=>{
 const m=mock(),v=await verifyNativePreview({...input,fetchImpl:m.fetchImpl,attempts:1});
 assert.equal(v.deploy_id,id);assert.equal(v.source_sha,commit);assert.equal(v.production_deploy_unchanged,true);
 assert.equal(v.deploy_url,native.deploy_ssl_url);assert.equal(m.calls.length,3);
 assert.ok(m.calls.every(x=>x.opts.method==='GET'&&x.opts.redirect==='error'));
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
