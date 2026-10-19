const test=require('node:test'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),path=require('node:path');
const model=()=>import(pathToFileURL(path.join(__dirname,'../supabase/functions/_shared/merchant-onboarding.mjs')));
const ready=()=>({status:'pending_provisioning',credentialsConfigured:true,features:{membership:true,booking:true},line:{adminChannelId:'123456',memberChannelId:'234567',messagingChannelId:'345678',adminLiffId:'123456-admin',memberLiffId:'234567-member',bookingLiffId:'234567-booking'}});
test('AC-101: saved configuration gives exact missing fields without exposing credentials',async()=>{
 const {merchantOnboarding}=await model(),tenant=ready();tenant.credentialsConfigured=false;tenant.line.bookingLiffId='';
 const status=merchantOnboarding(tenant);
 assert.equal(status.configurationComplete,false);assert.equal(status.stage,'configuration_required');
 assert.deepEqual(status.commonMissing,['credentials']);assert.deepEqual(status.features.booking.missing,['bookingLiffId']);
 assert.equal(status.features.membership.configured,true);assert.equal(status.features.points,undefined);
 assert.equal(status.adminReady,false);assert.equal(status.userReady,false);assert.equal(status.nextOwner,'merchant');
 assert.doesNotMatch(JSON.stringify(status),/123456|234567|345678|accessToken|channelSecret/);
});
test('AC-102: complete LINE settings and even a manual isolation flag never advertise unsupported business APIs',async()=>{
 const {merchantOnboarding}=await model(),tenant=ready();
 for(const status of ['pending_provisioning','active']){
  tenant.status=status;tenant.dataPlaneVerified=true;
  const result=merchantOnboarding(tenant);
  assert.equal(result.configurationComplete,true);assert.equal(result.stage,'awaiting_platform');
  assert.equal(result.adminReady,false);assert.equal(result.userReady,false);assert.equal(result.nextOwner,'platform');
  assert.deepEqual(result.blockers,['BUSINESS_RUNTIME_UNAVAILABLE']);
  assert.equal(result.features.membership.userReady,false);
 }
});
test('AC-103: mismatched LIFF prefix, suspension and no grants remain blocked',async()=>{
 const {merchantOnboarding}=await model(),tenant=ready();tenant.line.memberLiffId='999999-member';
 assert.deepEqual(merchantOnboarding(tenant).features.membership.missing,['memberLiffId']);
 tenant.status='suspended';assert.equal(merchantOnboarding(tenant).stage,'suspended');
 tenant.status='pending_provisioning';tenant.features={};assert.equal(merchantOnboarding(tenant).stage,'awaiting_grants');
 const malformed=merchantOnboarding({features:{membership:true},line:null});
 assert.equal(malformed.configurationComplete,false);assert.equal(malformed.userReady,false);
});
test('AC-205: a provisioned approved business is usable before LINE setup',async()=>{
 const {merchantOnboarding}=await model();const status=merchantOnboarding({status:'active',runtimeReady:true,features:{membership:true,points:true},line:{},credentialsConfigured:false});
 assert.equal(status.configurationComplete,false);assert.equal(status.adminReady,true);assert.equal(status.userReady,true);assert.equal(status.stage,'ready');assert.equal(status.features.points.userReady,true);
 assert.ok(!status.blockers.includes('BUSINESS_RUNTIME_UNAVAILABLE'));
});
