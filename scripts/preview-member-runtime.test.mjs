import test from 'node:test';
import assert from 'node:assert/strict';
import { previewMemberRuntime } from './preview-member-runtime.mjs';
const config={supabaseUrl:'https://example.supabase.co',supabaseFunctionUrl:'https://example.supabase.co/functions/v1/api',memberLiffId:'1234567890-synthetic'};
test('AC-PT-002: Integrated preview uses canonical development APIs without isolated preview routes',()=>{
 const result=previewMemberRuntime(config,{BRANCH:'Integrated-Marketing-Platform'});
 assert.equal(result.supabaseFunctionUrl,'https://bmwhojszsnxliekkhrka.supabase.co/functions/v1/api');
 assert.equal(result.pricePublishing,true);
 assert.equal(result.bookingPreviewApis,undefined);
 assert.equal(result.previewApiFunctionUrl,undefined);
 assert.equal(result.memberProfileFunctionUrl,undefined);
 assert.equal(result.memberGrowthFunctionUrl,undefined);
 assert.equal(result.memberLiffId,'2010787602-kaiSm2eq');
 assert.equal(config.pricePublishing,undefined);
 const fromPreview=previewMemberRuntime({...config,previewApiFunctionUrl:'https://example.supabase.co/functions/v1/api-preview',memberProfileFunctionUrl:'https://example.supabase.co/functions/v1/member-profile-api-preview',memberGrowthFunctionUrl:'https://example.supabase.co/functions/v1/member-growth-api-preview',bookingPreviewApis:true},{BRANCH:'Integrated-Marketing-Platform'});
 for(const key of ['previewApiFunctionUrl','memberProfileFunctionUrl','memberGrowthFunctionUrl','bookingPreviewApis'])assert.equal(fromPreview[key],undefined,key);
 assert.deepEqual(fromPreview,result);
});
test('non-Integrated, production and ambiguous build identities preserve original routes',()=>{
 for(const env of [{},{BRANCH:'main'},{BRANCH:'develop'},{BRANCH:'feature/test'},{BRANCH:'main',PREVIEW_SOURCE_BRANCH:'Integrated-Marketing-Platform'}])assert.deepEqual(previewMemberRuntime(config,env),config);
 assert.deepEqual(previewMemberRuntime(config,{PREVIEW_SOURCE_BRANCH:'Integrated-Marketing-Platform'}),{...config,supabaseUrl:'https://bmwhojszsnxliekkhrka.supabase.co',supabaseFunctionUrl:'https://bmwhojszsnxliekkhrka.supabase.co/functions/v1/api',supabasePublishableKey:'sb_publishable_Dk6cKyJ5ssJRxf7GGTlZug_K_J3GbK-',memberLiffId:'2010787602-kaiSm2eq',pointsLiffId:'2010787602-eIzRN9l6',adminLiffId:'2010791619-vhevCvvD',platformLiffId:'2012065297-VunxFBj8',eventLiffId:'2010787602-tuapstY3',calendarLiffId:'2010787602-4UKzslco',bookingLiffId:'2010787602-sgiB0ETj',pricePublishing:true});
});

test('AC-004: every environment removes stale preview overrides without mutating config', () => {
 const stale={...config,previewApiFunctionUrl:'https://example.supabase.co/functions/v1/api-preview',memberProfileFunctionUrl:'https://example.supabase.co/functions/v1/member-profile-api-preview',memberGrowthFunctionUrl:'https://example.supabase.co/functions/v1/member-growth-api-preview',bookingPreviewApis:true};
 const before=structuredClone(stale);
 for(const env of [{},{BRANCH:'main'},{BRANCH:'develop'},{BRANCH:'feature/test'},{BRANCH:'main',PREVIEW_SOURCE_BRANCH:'Integrated-Marketing-Platform'}]){
  assert.deepEqual(previewMemberRuntime(stale,env),config);
 }
 assert.deepEqual(stale,before);
 assert.equal(previewMemberRuntime({...stale,pricePublishing:false},{BRANCH:'main'}).pricePublishing,false);
});
