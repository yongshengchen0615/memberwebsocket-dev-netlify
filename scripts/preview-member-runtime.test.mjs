import test from 'node:test';
import assert from 'node:assert/strict';
import { previewMemberRuntime } from './preview-member-runtime.mjs';
const config={supabaseUrl:'https://example.supabase.co',supabaseFunctionUrl:'https://example.supabase.co/functions/v1/api',memberLiffId:'1234567890-synthetic'};
test('only the Integrated-Marketing-Platform branch uses isolated candidate APIs',()=>{
 const result=previewMemberRuntime(config,{BRANCH:'Integrated-Marketing-Platform'});
 assert.equal(result.supabaseFunctionUrl,'https://example.supabase.co/functions/v1/api-preview');
 assert.equal(result.memberProfileFunctionUrl,'https://example.supabase.co/functions/v1/member-profile-api-preview');
 assert.equal(result.memberLiffId,'1234567890-synthetic');
 assert.equal(config.supabaseFunctionUrl,'https://example.supabase.co/functions/v1/api');
});
test('production, feature branches and conflicting build identities preserve original API routes',()=>{
 for(const env of [{},{BRANCH:'main'},{BRANCH:'develop'},{BRANCH:'feature/test'},{BRANCH:'Integrated-Marketing-Platform',CONTEXT:'production'},{BRANCH:'main',PREVIEW_SOURCE_BRANCH:'Integrated-Marketing-Platform'}])assert.deepEqual(previewMemberRuntime(config,env),config);
 assert.equal(previewMemberRuntime(config,{PREVIEW_SOURCE_BRANCH:'Integrated-Marketing-Platform'}).supabaseFunctionUrl,'https://example.supabase.co/functions/v1/api-preview');
});
