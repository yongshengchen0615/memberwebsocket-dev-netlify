import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewMemberRuntime } from './preview-member-runtime.mjs';

const config={supabaseUrl:'https://example.supabase.co',supabaseFunctionUrl:'https://example.supabase.co/functions/v1/api',memberLiffId:'1234567890-synthetic'};
const readProfile = folder => {
 const data=JSON.parse(readFileSync(new URL('../MemberWebsocket-dev/config/'+folder+'/config.json',import.meta.url)));
 const {__environmentNotes,...values}=data;
 return values;
};

test('AC-PT-002: Integrated preview uses its separate testing JSON and canonical APIs',()=>{
 const profile=readProfile('testing');
 const result=previewMemberRuntime(config,{BRANCH:'Integrated-Marketing-Platform'});
 assert.equal(result.supabaseFunctionUrl,'https://bmwhojszsnxliekkhrka.supabase.co/functions/v1/api');
 assert.equal(result.pricePublishing,true);
 assert.equal(result.bookingPreviewApis,undefined);
 assert.equal(result.previewApiFunctionUrl,undefined);
 assert.equal(result.memberProfileFunctionUrl,undefined);
 assert.equal(result.memberGrowthFunctionUrl,undefined);
 assert.equal(result.memberLiffId,profile.memberLiffId);
 assert.equal(config.pricePublishing,undefined);
 const fromPreview=previewMemberRuntime({...config,previewApiFunctionUrl:'https://example.supabase.co/functions/v1/api-preview',memberProfileFunctionUrl:'https://example.supabase.co/functions/v1/member-profile-api-preview',memberGrowthFunctionUrl:'https://example.supabase.co/functions/v1/member-growth-api-preview',bookingPreviewApis:true},{BRANCH:'Integrated-Marketing-Platform'});
 for(const key of ['previewApiFunctionUrl','memberProfileFunctionUrl','memberGrowthFunctionUrl','bookingPreviewApis'])assert.equal(fromPreview[key],undefined,key);
 assert.deepEqual(fromPreview,result);
 assert.deepEqual(result,{...profile,pricePublishing:true});
});

test('AC-PT-002: local unknown branches remain unchanged and selected branch only reads its own JSON',()=>{
 for(const env of [{},{BRANCH:'main'},{BRANCH:'develop'},{BRANCH:'feature/test'},{BRANCH:'main',PREVIEW_SOURCE_BRANCH:'Integrated-Marketing-Platform'}])assert.deepEqual(previewMemberRuntime(config,env),config);
 assert.deepEqual(previewMemberRuntime(config,{PREVIEW_SOURCE_BRANCH:'Integrated-Marketing-Platform'}),{...readProfile('testing'),pricePublishing:true});
 assert.deepEqual(previewMemberRuntime(config,{BRANCH:'master',CONTEXT:'production'}),readProfile('production'));
});

test('AC-004: every environment strips stale preview overrides without modifying input',()=>{
 const stale={...config,previewApiFunctionUrl:'https://example.supabase.co/functions/v1/api-preview',memberProfileFunctionUrl:'https://example.supabase.co/functions/v1/member-profile-api-preview',memberGrowthFunctionUrl:'https://example.supabase.co/functions/v1/member-growth-api-preview',bookingPreviewApis:true};
 const before=structuredClone(stale);
 for(const env of [{},{BRANCH:'main'},{BRANCH:'develop'},{BRANCH:'feature/test'},{BRANCH:'main',PREVIEW_SOURCE_BRANCH:'Integrated-Marketing-Platform'}])assert.deepEqual(previewMemberRuntime(stale,env),config);
 assert.deepEqual(stale,before);
 assert.equal(previewMemberRuntime({...stale,pricePublishing:false},{BRANCH:'main'}).pricePublishing,false);
});
