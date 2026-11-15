const test=require('node:test'),assert=require('node:assert/strict');
const auth=()=>import('../supabase/functions/_shared/platform-auth.mjs');
const main='https://dbuquirnaskrwcamdxki.supabase.co',testing='https://bmwhojszsnxliekkhrka.supabase.co';
const mainSite='https://memberwebsocket-dev-netlify.netlify.app';
const testSite='https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app';
const initialTime=1800000000000;
function fixture(projectUrl=main){
 let time=initialTime,config={supabaseUrl:projectUrl,supabaseFunctionUrl:projectUrl+'/functions/v1/api',platformLiffId:'2011356226-Root',adminLiffId:'2011356226-Admin'},failure=null,wrongAudience=false;
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(url==='https://api.line.me/oauth2/v2.1/verify')return Response.json({sub:'U'+'1'.repeat(32),name:'Synthetic',aud:wrongAudience?'2010791619':options.body.get('client_id'),iss:'https://access.line.me',iat:time/1000-30,exp:time/1000+300});
  if(failure)throw Error('private-network-detail');
  return Response.json(config);
 };
 return {calls,fetchImpl,now:()=>time,advance:ms=>{time+=ms;},setConfig:value=>{config=value;},fail:()=>{failure=true;},wrongAudience:()=>{wrongAudience=true;}};
}
test('AC-ROUTING-005: trusted project selects its pinned config origin and LINE verifies its configured role channels',async()=>{
 const {createDeploymentLineVerifiers}=await auth();
 for(const [projectUrl,site]of [[main,mainSite],[testing,testSite]]){
  const f=fixture(projectUrl),v=createDeploymentLineVerifiers({projectUrl,fetchImpl:f.fetchImpl,now:f.now});
  await v.verifyIdentity('synthetic-token');await v.verifyApplicantIdentity('synthetic-token');
  assert.equal(f.calls[0].url,site+'/config/config.json');
  assert.equal(f.calls[0].options.redirect,'error');assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(f.calls.filter(c=>c.url.includes('oauth2')).map(c=>c.options.body.get('client_id')),['2011356226','2011356226']);
  assert.equal(f.calls.length,3,'one cached config read plus two real verifier calls');
  f.wrongAudience();await assert.rejects(v.verifyIdentity('synthetic-token'),e=>e.status===401&&e.code==='AUTH_INVALID');
 }
});
test('AC-ROUTING-006: concurrent logins coalesce config reads and refreshed config changes channels without redeploy',async()=>{
 const {createDeploymentLineVerifiers}=await auth();const f=fixture(),v=createDeploymentLineVerifiers({projectUrl:main,fetchImpl:f.fetchImpl,now:f.now});
 await Promise.all([v.verifyIdentity('token-a'),v.verifyIdentity('token-b'),v.verifyApplicantIdentity('token-c')]);
 assert.equal(f.calls.filter(c=>!c.url.includes('oauth2')).length,1);
 f.setConfig({supabaseUrl:main,supabaseFunctionUrl:main+'/functions/v1/api',platformLiffId:'2099999999-NewRoot',adminLiffId:'2088888888-NewAdmin'});f.advance(60000);
 await v.verifyIdentity('token-d');await v.verifyApplicantIdentity('token-e');
 assert.deepEqual(f.calls.slice(-2).map(c=>c.options.body.get('client_id')),['2099999999','2088888888']);
 assert.equal(f.calls.filter(c=>!c.url.includes('oauth2')).length,2);
});
test('AC-ROUTING-007: malformed/cross-project config, unknown projects and unavailable config fail closed without LINE calls',async()=>{
 const {createDeploymentLineVerifiers}=await auth();
 for(const config of [null,[],{}, {supabaseUrl:testing,supabaseFunctionUrl:testing+'/functions/v1/api',platformLiffId:'2011356226-Root',adminLiffId:'2011356226-Admin'},{supabaseUrl:main,supabaseFunctionUrl:testing+'/functions/v1/api',platformLiffId:'2011356226-Root',adminLiffId:'2011356226-Admin'},{supabaseUrl:main,supabaseFunctionUrl:main+'/functions/v1/api',platformLiffId:'bad',adminLiffId:'2011356226-Admin'}]){
  const f=fixture();f.setConfig(config);const v=createDeploymentLineVerifiers({projectUrl:main,fetchImpl:f.fetchImpl,now:f.now});
  await assert.rejects(v.verifyIdentity('token'),e=>e.status===503&&e.code==='LINE_CONFIG_UNAVAILABLE');
  assert.equal(f.calls.filter(c=>c.url.includes('oauth2')).length,0);
 }
 const f=fixture(),unknown=createDeploymentLineVerifiers({projectUrl:'https://attacker.test',fetchImpl:f.fetchImpl,now:f.now});
 await assert.rejects(unknown.verifyIdentity('token'),e=>e.status===503);assert.equal(f.calls.length,0);
 const v=createDeploymentLineVerifiers({projectUrl:main,fetchImpl:f.fetchImpl,now:f.now});await v.verifyIdentity('token');f.advance(60000);f.fail();
 await assert.rejects(v.verifyIdentity('token'),e=>e.status===503&&!e.message.includes('private-network-detail'));
 assert.equal(f.calls.filter(c=>c.url.includes('oauth2')).length,1,'expired cached channels cannot authenticate during config outage');
});
test('AC-ROUTING-008: tenant channel remains server-selected and empty tokens never trigger config or LINE requests',async()=>{
 const {createDeploymentLineVerifiers}=await auth();const f=fixture(),v=createDeploymentLineVerifiers({projectUrl:main,fetchImpl:f.fetchImpl,now:f.now});
 for(const token of ['',null,'x'.repeat(10001)])await assert.rejects(v.verifyIdentity(token),e=>e.status===401&&e.code==='AUTH_REQUIRED');
 assert.equal(f.calls.length,0);
 await v.verifyApplicantIdentity('token','2077777777');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.body.get('client_id'),'2077777777');
});
