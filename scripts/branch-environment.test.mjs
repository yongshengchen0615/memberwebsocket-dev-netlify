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
const original={supabaseUrl:production,supabaseFunctionUrl:production+'/functions/v1/api',supabasePublishableKey:'sb_publishable_W492suU5Hb7LJIJ2DmHbZw_KVp9vB4S',memberLiffId:'synthetic'};
const pinnedLiff={
 memberLiffId:'2010787602-kaiSm2eq',
 pointsLiffId:'2010787602-eIzRN9l6',
 adminLiffId:'2010791619-vhevCvvD',
 platformLiffId:'2012065297-VunxFBj8',
 eventLiffId:'2010787602-tuapstY3',
 calendarLiffId:'2010787602-4UKzslco',
 bookingLiffId:'2010787602-sgiB0ETj',
};

test('AC-007: JSON configuration annotates 3 Supabase and 7 LIFF environment-specific fields but publishes no notes',()=>{
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const source=JSON.parse(readFileSync(path.join(repo,'MemberWebsocket-dev/config.json'),'utf8'));
 const expectedKeys=["supabaseUrl","supabaseFunctionUrl","supabasePublishableKey","memberLiffId","pointsLiffId","adminLiffId","platformLiffId","eventLiffId","calendarLiffId","bookingLiffId"];
 assert.equal(Object.keys(source).length,15,'14 runtime settings plus one authoring-only annotation');
 assert.ok(source.__environmentNotes && typeof source.__environmentNotes === 'object');
 for(const key of expectedKeys){
  assert.ok(Object.hasOwn(source,key),'runtime setting missing: '+key);
  assert.equal(typeof source.__environmentNotes[key],'string','missing environment guidance: '+key);
  assert.ok(source.__environmentNotes[key].length>15,'insufficient annotation: '+key);
 }
 for(const [branch,context,project] of [['master','production','dbuquirnaskrwcamdxki'],['Integrated-Marketing-Platform','branch-deploy','bmwhojszsnxliekkhrka']]){
  const runtime=previewMemberRuntime(source,{BRANCH:branch,CONTEXT:context});
  assert.equal(runtime.__environmentNotes,undefined,'authoring notes must not reach published client');
  assert.equal(runtime.supabaseUrl,'https://'+project+'.supabase.co');
  assert.equal(runtime.supabaseFunctionUrl,runtime.supabaseUrl+'/functions/v1/api');
  assert.equal(Object.keys(runtime).length,branch==='master'?14:15);
  for(const key of expectedKeys.slice(3))assert.equal(runtime[key],source[key],'LIFF values must not silently change for '+branch);
 }
});

test('AC-001: Integrated build connects all canonical APIs and Realtime to the testing project',()=>{
 const actual=previewMemberRuntime(original,{BRANCH:'Integrated-Marketing-Platform',CONTEXT:'branch-deploy'});
 assert.equal(actual.supabaseUrl,testing);
 assert.equal(actual.supabaseFunctionUrl,testing+'/functions/v1/api');
 assert.equal(actual.supabaseGrantAutomationUrl,undefined);
 assert.equal(actual.memberCalendarFunctionUrl,undefined);
 assert.equal(actual.supabasePublishableKey,'sb_publishable_Dk6cKyJ5ssJRxf7GGTlZug_K_J3GbK-');
 assert.deepEqual(Object.fromEntries(Object.keys(pinnedLiff).map(key=>[key,actual[key]])),pinnedLiff);
 assert.equal(JSON.stringify(actual).includes('dbuquirnaskrwcamdxki'),false);
 assert.equal(original.supabaseUrl,production);
});

test('AC-002: master restores the production project even if source config was testing',()=>{
 const actual=previewMemberRuntime({...original,supabaseUrl:testing,supabaseFunctionUrl:testing+'/functions/v1/api',supabasePublishableKey:'sb_publishable_Dk6cKyJ5ssJRxf7GGTlZug_K_J3GbK-'},{BRANCH:'master',CONTEXT:'production'});
 assert.equal(actual.supabaseUrl,production);
 assert.equal(actual.supabaseFunctionUrl,production+'/functions/v1/api');
 assert.equal(actual.supabaseGrantAutomationUrl,undefined);
 assert.equal(actual.memberCalendarFunctionUrl,undefined);
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


test('AC-008: merging a poisoned test config cannot overwrite production or testing LIFF identity',()=>{
 const poisoned={...original,...Object.fromEntries(Object.keys(pinnedLiff).map(key=>[key,'1234567890-MergedTest']))};
 for(const [branch,context] of [['master','production'],['Integrated-Marketing-Platform','branch-deploy']]){
  const actual=previewMemberRuntime(poisoned,{BRANCH:branch,CONTEXT:context});
  for(const [key,value] of Object.entries(pinnedLiff))assert.equal(actual[key],value,branch+': '+key);
  assert.equal(JSON.stringify(actual).includes('MergedTest'),false);
 }
});

test('AC-009: independent Netlify LIFF profiles override all seven source values without cross-contamination',()=>{
 const makeProfile=(prefix)=>Object.fromEntries(Object.keys(pinnedLiff).map((key,index)=>[key,'1234567890-'+prefix+String(index)]));
 const productionProfile=makeProfile('Production');
 const testProfile=makeProfile('Testing');
 const env={PUBLIC_LIFF_CONFIG_PRODUCTION:JSON.stringify(productionProfile),PUBLIC_LIFF_CONFIG_TEST:JSON.stringify(testProfile)};
 const poisoned={...original,...makeProfile('Merged')};
 const prod=previewMemberRuntime(poisoned,{...env,BRANCH:'master',CONTEXT:'production'});
 const testRuntime=previewMemberRuntime(poisoned,{...env,BRANCH:'Integrated-Marketing-Platform',CONTEXT:'branch-deploy'});
 for(const key of Object.keys(pinnedLiff)){
  assert.equal(prod[key],productionProfile[key]);
  assert.equal(testRuntime[key],testProfile[key]);
  assert.notEqual(prod[key],testRuntime[key]);
 }
 assert.equal(prod.supabaseUrl,production);
 assert.equal(testRuntime.supabaseUrl,testing);
});

test('AC-010: invalid or partial site profiles fail closed before publishing',()=>{
 const baseline={...original,BRANCH:'master'};
 for(const value of ['', 'not json', '{}', '[]', JSON.stringify({...pinnedLiff,memberLiffId:'sb_secret_not_a_liff'}), JSON.stringify({...pinnedLiff,unknown:'extra'})]){
  assert.throws(()=>previewMemberRuntime(baseline,{BRANCH:'master',CONTEXT:'production',PUBLIC_LIFF_CONFIG_PRODUCTION:value}),/Invalid PUBLIC_LIFF_CONFIG_PRODUCTION/);
  assert.throws(()=>previewMemberRuntime(baseline,{BRANCH:'Integrated-Marketing-Platform',CONTEXT:'branch-deploy',PUBLIC_LIFF_CONFIG_TEST:value}),/Invalid PUBLIC_LIFF_CONFIG_TEST/);
 }
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
   assert.equal(config.__environmentNotes,undefined,'authoring notes must not leak to Netlify');
   assert.equal(readFileSync(path.join(output,'admin/index.html'),'utf8').includes('https://'+ref+'.supabase.co'),true,'receipt CSP uses the same project');
   for(const file of readdirSync(output,{recursive:true}).filter(f=>/\.(html|js|json|css)$/.test(f)))assert.equal(readFileSync(path.join(output,file),'utf8').includes(forbidden),false,branch+': '+file+' leaks another project');
  }
 } finally {rmSync(fixture,{recursive:true,force:true});}
});
