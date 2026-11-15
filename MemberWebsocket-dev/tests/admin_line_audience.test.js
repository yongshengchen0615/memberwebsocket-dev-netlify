const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=x=>fs.readFileSync(path.join(__dirname,'..',x),'utf8');
const prod='https://dbuquirnaskrwcamdxki.supabase.co',sandbox='https://bmwhojszsnxliekkhrka.supabase.co';
const origin={ [prod]:'https://memberwebsocket-dev-netlify.netlify.app',[sandbox]:'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app' };

test('AC-401-001: default admin audience comes from the trusted environment LIFF',async()=>{
 const {createDeploymentLineVerifiers}=await import('../supabase/functions/_shared/platform-auth.mjs');
 for(const [projectUrl,site] of Object.entries(origin)){
  const expected=projectUrl===prod?'2011356226':'2010791619',reads=[];
  const verifiers=createDeploymentLineVerifiers({projectUrl,fetchImpl:async(url,options)=>{
    reads.push(url);assert.equal(url,site+'/config/config.json');assert.equal(options.redirect,'error');
    return Response.json({supabaseUrl:projectUrl,supabaseFunctionUrl:projectUrl+'/functions/v1/api',adminLiffId:expected+'-Admin',platformLiffId:(projectUrl===prod?'2011356226':'2012065297')+'-Root'});
  }});
  assert.equal(await verifiers.adminChannelId(),expected);
  assert.equal(await verifiers.adminChannelId(),expected);
  assert.equal(reads.length,1,'only one configuration read');
 }
});

test('AC-401-002: cross-project and malformed config fail closed before authorizing a LINE audience',async()=>{
 const {createDeploymentLineVerifiers}=await import('../supabase/functions/_shared/platform-auth.mjs');
 for(const data of [{},{supabaseUrl:sandbox,supabaseFunctionUrl:sandbox+'/functions/v1/api',adminLiffId:'2010791619-A',platformLiffId:'2012065297-B'}]){
  const verifier=createDeploymentLineVerifiers({projectUrl:prod,fetchImpl:async()=>Response.json(data)});
  await assert.rejects(verifier.adminChannelId(),err=>err.status===503&&err.code==='LINE_CONFIG_UNAVAILABLE');
 }
});

test('AC-401-003: default and tenant admin routes remain distinct and verified server-side',()=>{
 const business=read('supabase/functions/_shared/business-runtime.ts');
 const api=read('supabase/functions/api/index.ts'),contract=read('supabase/functions/_shared/auth-contract.ts');
 assert.match(business,/c\.adminCustomLineReady\s*\? businessEnv\('LINE_ADMIN_CHANNEL_ID'\)\s*: await deploymentAdminChannelId\(\)/);
 assert.match(business,/verifyMerchantAdminIdToken\(\{idToken:body\.idToken\},adminChannel\)/);
 assert.match(api,/clientType === "admin" && !businessContext\(\)\?\.adminCustomLineReady/);
 assert.match(api,/expectedChannelId: await channelIdFor\(clientType\)/);
 assert.match(api,/isAdminLogin: clientType === "admin"/);
 assert.match(contract,/isActiveAdmin && \(/);
 assert.match(contract,/isAdminLogin === undefined \? expectedChannelId === adminChannelId : isAdminLogin === true/);
});

test('AC-401-004: unavailable config is not replaced by a legacy channel or a leaked provider error',async()=>{
 const {createDeploymentLineVerifiers}=await import('../supabase/functions/_shared/platform-auth.mjs');
 const verifier=createDeploymentLineVerifiers({projectUrl:prod,fetchImpl:async()=>{throw Error('internal/private')}});
 await assert.rejects(verifier.adminChannelId(),err=>err.status===503&&!err.message.includes('internal/private'));
 assert.match(read('supabase/functions/api/index.ts'),/throw new ApiError\(503,"LINE_CONFIG_UNAVAILABLE"/);
});
