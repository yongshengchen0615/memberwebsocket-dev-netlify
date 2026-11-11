import test from 'node:test';
import assert from 'node:assert/strict';
import {previewMemberRuntime} from './preview-member-runtime.mjs';
import {blockNativePreview} from './netlify-preview-source.mjs';
import {cpSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const production='https://dbuquirnaskrwcamdxki.supabase.co';
const testing='https://bmwhojszsnxliekkhrka.supabase.co';
const original={supabaseUrl:production,supabaseFunctionUrl:production+'/functions/v1/api',supabaseGrantAutomationUrl:production+'/functions/v1/grant-automation',memberCalendarFunctionUrl:production+'/functions/v1/member-calendar-api',supabasePublishableKey:'sb_publishable_W492suU5Hb7LJIJ2DmHbZw_KVp9vB4S',memberLiffId:'synthetic'};

test('AC-001: Integrated build connects all canonical APIs and Realtime to the testing project',()=>{
 const actual=previewMemberRuntime(original,{BRANCH:'Integrated-Marketing-Platform',CONTEXT:'branch-deploy'});
 assert.equal(actual.supabaseUrl,testing);
 assert.equal(actual.supabaseFunctionUrl,testing+'/functions/v1/api');
 assert.equal(actual.supabaseGrantAutomationUrl,testing+'/functions/v1/grant-automation');
 assert.equal(actual.memberCalendarFunctionUrl,testing+'/functions/v1/member-calendar-api');
 assert.equal(actual.supabasePublishableKey,'sb_publishable_Dk6cKyJ5ssJRxf7GGTlZug_K_J3GbK-');
 assert.equal(actual.memberLiffId,'synthetic');
 assert.equal(JSON.stringify(actual).includes('dbuquirnaskrwcamdxki'),false);
 assert.equal(original.supabaseUrl,production);
});

test('AC-002: master restores the production project even if source config was testing',()=>{
 const actual=previewMemberRuntime({...original,supabaseUrl:testing,supabaseFunctionUrl:testing+'/functions/v1/api',supabasePublishableKey:'sb_publishable_Dk6cKyJ5ssJRxf7GGTlZug_K_J3GbK-'},{BRANCH:'master',CONTEXT:'production'});
 assert.equal(actual.supabaseUrl,production);
 assert.equal(actual.supabaseFunctionUrl,production+'/functions/v1/api');
 assert.equal(actual.supabasePublishableKey,'sb_publishable_W492suU5Hb7LJIJ2DmHbZw_KVp9vB4S');
 assert.equal(JSON.stringify(actual).includes('bmwhojszsnxliekkhrka'),false);
});

test('AC-003: a confused Integrated identity fails instead of using production',()=>{
 for(const env of [{BRANCH:'integrated-marketing-platform',CONTEXT:'branch-deploy'},{BRANCH:'Integrated-Marketing-Platform',CONTEXT:'production'}])assert.throws(()=>previewMemberRuntime(original,env),/identity/i);
});

test('other branch names cannot select inherited object properties as projects',()=>{
 assert.deepEqual(previewMemberRuntime(original,{BRANCH:'constructor'}),original);
});

test('PR previews use the testing project and unexpected native production builds fail closed',()=>{
 const result=previewMemberRuntime(original,{NETLIFY:'true',BRANCH:'chore/review',CONTEXT:'deploy-preview'});
 assert.equal(result.supabaseUrl,testing);
 assert.equal(JSON.stringify(result).includes('dbuquirnaskrwcamdxki'),false);
 assert.equal(blockNativePreview({NETLIFY:'true',BRANCH:'chore/review',CONTEXT:'production'}),true);
});

test('AC-006: native master builds are blocked while CI can build the release',()=>{
 assert.equal(blockNativePreview({NETLIFY:'true',BRANCH:'master',CONTEXT:'production'}),true);
 assert.equal(blockNativePreview({BRANCH:'master',GITHUB_ACTIONS:'true'}),false);
});

test('AC-001/002: complete bundles contain only their branch project including receipt image CSP',()=>{
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const fixture=mkdtempSync(path.join(tmpdir(),'branch-environment-'));
 try {
  for(const name of ['scripts','MemberWebsocket-dev'])cpSync(path.join(repo,name),path.join(fixture,name),{recursive:true,filter:p=>!p.split(path.sep).includes('node_modules')});
  for(const [branch,context,ref,forbidden] of [['Integrated-Marketing-Platform','branch-deploy','bmwhojszsnxliekkhrka','dbuquirnaskrwcamdxki'],['master','production','dbuquirnaskrwcamdxki','bmwhojszsnxliekkhrka']]){
   const run=spawnSync(process.execPath,['scripts/build-site.mjs'],{cwd:fixture,encoding:'utf8',env:{...process.env,BRANCH:branch,CONTEXT:context,COMMIT_REF:'b'.repeat(40)}});
   assert.equal(run.status,0,run.stderr);
   const output=path.join(fixture,'dist');
   const config=JSON.parse(readFileSync(path.join(output,'config.json'),'utf8'));
   assert.equal(config.supabaseUrl,'https://'+ref+'.supabase.co');
   assert.equal(readFileSync(path.join(output,'admin/index.html'),'utf8').includes('https://'+ref+'.supabase.co'),true,'receipt CSP uses the same project');
   for(const file of readdirSync(output,{recursive:true}).filter(f=>/\.(html|js|json|css)$/.test(f)))assert.equal(readFileSync(path.join(output,file),'utf8').includes(forbidden),false,branch+': '+file+' leaks another project');
  }
 } finally {rmSync(fixture,{recursive:true,force:true});}
});
