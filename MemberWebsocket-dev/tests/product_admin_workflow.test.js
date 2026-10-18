const test=require('node:test'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),path=require('node:path');
const auth=()=>import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/platform-auth.mjs')));
test('AC-017: merchant verification accepts only the admin LINE channel, root verification rejects it',async()=>{
 const {verifyMerchantAdminIdToken,verifyPlatformIdToken}=await auth();
 const now=1800000000000,claims={sub:'U'+'2'.repeat(32),aud:'2010791619',iss:'https://access.line.me',name:'一般管理員',iat:now/1000-1,exp:now/1000+300};
 const verify=verifier=>verifier({idToken:'synthetic',now:()=>now,fetchImpl:async()=>new Response(JSON.stringify(claims))});
 assert.equal((await verify(verifyMerchantAdminIdToken)).displayName,'一般管理員');
 await assert.rejects(verify(verifyPlatformIdToken),e=>e.code==='AUTH_INVALID');
 claims.aud='2012065297';await assert.rejects(verify(verifyMerchantAdminIdToken),e=>e.code==='AUTH_INVALID');
});
test('AC-017: applicant actions and root operations choose distinct trusted verifiers',async()=>{
 const {createPlatformHandler}=await import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/platform-handler.mjs')));
 const {PlatformError}=await import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/platform-policy.mjs')));
 let applicant=0,root=0;
 const handler=createPlatformHandler({db:{rpc:()=>assert.fail('no DB call after rejected identity')},allowedOrigins:new Set(),encryptionKey:()=>'',
 verifyApplicantIdentity:async()=>{applicant++;throw new PlatformError(401,'AUTH_INVALID','拒絕');},verifyIdentity:async()=>{root++;throw new PlatformError(401,'AUTH_INVALID','拒絕');}});
 for(const action of ['platform.application.ensure','platform.application.bootstrap','platform.application.submit','platform.line.save','platform.bootstrap','platform.application.approve','platform.tenant.features.save'])
  assert.equal((await handler(new Request('https://backend.test',{method:'POST',body:JSON.stringify({action,idToken:'synthetic'})}))).status,401);
 assert.equal(applicant,4);assert.equal(root,3);
});
