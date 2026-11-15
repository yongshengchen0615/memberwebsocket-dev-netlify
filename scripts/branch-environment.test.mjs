import test from 'node:test';
import assert from 'node:assert/strict';
import {previewMemberRuntime} from './preview-member-runtime.mjs';
import {blockNativePreview} from './netlify-preview-source.mjs';
import {cpSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const production='https://dbuquirnaskrwcamdxki.supabase.co';
const testing='https://bmwhojszsnxliekkhrka.supabase.co';
const original={supabaseUrl:production,supabaseFunctionUrl:production+'/functions/v1/api',supabasePublishableKey:'sb_publishable_W492suU5Hb7LJIJ2DmHbZw_KVp9vB4S',memberLiffId:'synthetic'};
const liffKeys=['memberLiffId','pointsLiffId','adminLiffId','platformLiffId',
 'eventLiffId','calendarLiffId','bookingLiffId'];
const testRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const environmentProfile=branch=>{
 const folder=branch==='master'?'production':'testing';
 const data=JSON.parse(readFileSync(path.join(testRoot,'MemberWebsocket-dev/config',folder,'config.json'),'utf8'));
 const {__environmentNotes,...profile}=data;
 return profile;
};
const expectedLiff=branch=>{
 const profile=environmentProfile(branch);
 return Object.fromEntries(liffKeys.map(key=>[key,profile[key]]));
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
  for(const key of expectedKeys.slice(3))assert.equal(runtime[key],environmentProfile(branch)[key],'LIFF must match the environment config for '+branch);
 }
});

test('AC-001: Integrated build connects all canonical APIs and Realtime to the testing project',()=>{
 const actual=previewMemberRuntime(original,{BRANCH:'Integrated-Marketing-Platform',CONTEXT:'branch-deploy'});
 assert.equal(actual.supabaseUrl,testing);
 assert.equal(actual.supabaseFunctionUrl,testing+'/functions/v1/api');
 assert.equal(actual.supabaseGrantAutomationUrl,undefined);
 assert.equal(actual.memberCalendarFunctionUrl,undefined);
 assert.equal(actual.supabasePublishableKey,environmentProfile('Integrated-Marketing-Platform').supabasePublishableKey);
 assert.deepEqual(Object.fromEntries(liffKeys.map(key=>[key,actual[key]])),expectedLiff('Integrated-Marketing-Platform'));
 assert.equal(JSON.stringify(actual).includes('dbuquirnaskrwcamdxki'),false);
 assert.equal(original.supabaseUrl,production);
});

test('AC-002: master restores the production project even if source config was testing',()=>{
 const actual=previewMemberRuntime({...original,supabaseUrl:testing,supabaseFunctionUrl:testing+'/functions/v1/api',supabasePublishableKey:'sb_publishable_Dk6cKyJ5ssJRxf7GGTlZug_K_J3GbK-'},{BRANCH:'master',CONTEXT:'production'});
 assert.equal(actual.supabaseUrl,production);
 assert.equal(actual.supabaseFunctionUrl,production+'/functions/v1/api');
 assert.equal(actual.supabaseGrantAutomationUrl,undefined);
 assert.equal(actual.memberCalendarFunctionUrl,undefined);
 assert.equal(actual.supabasePublishableKey,environmentProfile('master').supabasePublishableKey);
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
 const poisoned={...original,...Object.fromEntries(liffKeys.map(key=>[key,'1234567890-MergedTest']))};
 for(const [branch,context] of [['master','production'],['Integrated-Marketing-Platform','branch-deploy']]){
  const actual=previewMemberRuntime(poisoned,{BRANCH:branch,CONTEXT:context});
  for(const [key,value] of Object.entries(expectedLiff(branch)))assert.equal(actual[key],value,branch+': '+key);
  assert.equal(JSON.stringify(actual).includes('MergedTest'),false);
 }
});

test('AC-009/010: external variables cannot override either tracked environment config.json',()=>{
 const poisoned={...original,...Object.fromEntries(liffKeys.map(key=>[key,'1234567890-MergedTest']))};
 const env={PUBLIC_LIFF_CONFIG_PRODUCTION:'{}',PUBLIC_LIFF_CONFIG_TEST:'{"memberLiffId":"1234567890-Bad"}'};
 for(const [branch,context,ref] of [['master','production','dbuquirnaskrwcamdxki'],['Integrated-Marketing-Platform','branch-deploy','bmwhojszsnxliekkhrka']]){
  const actual=previewMemberRuntime(poisoned,{...env,BRANCH:branch,CONTEXT:context});
  for(const [key,value] of Object.entries(expectedLiff(branch)))assert.equal(actual[key],value,branch+' must use its own config.json: '+key);
  assert.equal(actual.supabaseUrl,'https://'+ref+'.supabase.co');
 }
});

test('AC-001/002: complete bundles contain only their branch project including receipt image CSP',()=>{
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const fixture=mkdtempSync(path.join(tmpdir(),'branch-environment-'));
 try {
  for(const name of ['scripts','MemberWebsocket-dev'])cpSync(path.join(repo,name),path.join(fixture,name),{recursive:true,filter:p=>!p.split(path.sep).includes('node_modules')});
  // Simulate a feature merge that replaces every tracked source environment
  // setting with the wrong project and a different LIFF app.
  const templatePath=path.join(fixture,'MemberWebsocket-dev/config.json');
  const mergedSource=JSON.parse(readFileSync(templatePath,'utf8'));
  Object.assign(mergedSource,Object.fromEntries(liffKeys.map(key=>[key,'1234567890-MergedTest'])),{
   supabaseUrl:testing,
   supabaseFunctionUrl:testing+'/functions/v1/api',
   supabasePublishableKey:'sb_publishable_Dk6cKyJ5ssJRxf7GGTlZug_K_J3GbK-',
  });
  writeFileSync(templatePath,JSON.stringify(mergedSource));

  for(const [branch,context,ref,forbidden] of [['Integrated-Marketing-Platform','branch-deploy','bmwhojszsnxliekkhrka','dbuquirnaskrwcamdxki'],['master','production','dbuquirnaskrwcamdxki','bmwhojszsnxliekkhrka']]){
   const run=spawnSync(process.execPath,['scripts/build-site.mjs'],{cwd:fixture,encoding:'utf8',env:{...process.env,BRANCH:branch,CONTEXT:context,COMMIT_REF:'b'.repeat(40)}});
   assert.equal(run.status,0,run.stderr);
   const output=path.join(fixture,'dist');
   const config=JSON.parse(readFileSync(path.join(output,'config.json'),'utf8'));
   assert.equal(config.supabaseUrl,'https://'+ref+'.supabase.co');
   assert.equal(config.__environmentNotes,undefined,'authoring notes must not leak to Netlify');
   for(const [key,value] of Object.entries(expectedLiff(branch)))assert.equal(config[key],value,branch+': LIFF overwritten by merged source: '+key);
   assert.equal(readFileSync(path.join(output,'admin/index.html'),'utf8').includes('https://'+ref+'.supabase.co'),true,'receipt CSP uses the same project');
   for(const file of readdirSync(output,{recursive:true}).filter(f=>/\.(html|js|json|css)$/.test(f)))assert.equal(readFileSync(path.join(output,file),'utf8').includes(forbidden),false,branch+': '+file+' leaks another project');
  }
 } finally {rmSync(fixture,{recursive:true,force:true});}
});


test('AC-014/015: editing one environment config.json changes only its own complete release config',()=>{
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const fixture=mkdtempSync(path.join(tmpdir(),'config-profiles-'));
 try{
  for(const name of ['scripts','MemberWebsocket-dev'])cpSync(path.join(repo,name),path.join(fixture,name),{recursive:true,filter:p=>!p.split(path.sep).includes('node_modules')});
  const {PUBLIC_LIFF_CONFIG_PRODUCTION:excludedProd,PUBLIC_LIFF_CONFIG_TEST:excludedTest,...baseEnv}=process.env;
  const build=(branch,context)=>{
   const run=spawnSync(process.execPath,['scripts/build-site.mjs'],{cwd:fixture,encoding:'utf8',env:{...baseEnv,BRANCH:branch,CONTEXT:context,COMMIT_REF:'b'.repeat(40)}});
   assert.equal(run.status,0,run.stderr);
   return JSON.parse(readFileSync(path.join(fixture,'dist/config.json'),'utf8'));
  };
  const prodPath=path.join(fixture,'MemberWebsocket-dev/config/production/config.json');
  const testPath=path.join(fixture,'MemberWebsocket-dev/config/testing/config.json');
  const initialProd=build('master','production');
  const initialTest=build('Integrated-Marketing-Platform','branch-deploy');
  const testSource=JSON.parse(readFileSync(testPath,'utf8'));
  testSource.brandName='TEST_ONLY_CUSTOM_BRAND';
  testSource.realtimeEnabled=false;
  testSource.memberLiffId='1234567890-TestingOnly';
  writeFileSync(testPath,JSON.stringify(testSource));
  const changedTest=build('Integrated-Marketing-Platform','branch-deploy');
  const prodAfterTestMerge=build('master','production');
  assert.equal(changedTest.brandName,'TEST_ONLY_CUSTOM_BRAND');
  assert.equal(changedTest.realtimeEnabled,false);
  assert.equal(changedTest.memberLiffId,'1234567890-TestingOnly');
  assert.deepEqual(prodAfterTestMerge,initialProd,'testing config edit must not change production output');
  const prodSource=JSON.parse(readFileSync(prodPath,'utf8'));
  prodSource.brandName='PRODUCTION_ONLY_CUSTOM_BRAND';
  prodSource.realtimeEnabled=false;
  prodSource.memberLiffId='1234567890-ProductionOnly';
  writeFileSync(prodPath,JSON.stringify(prodSource));
  const changedProd=build('master','production');
  const testAfterProdMerge=build('Integrated-Marketing-Platform','branch-deploy');
  assert.equal(changedProd.brandName,'PRODUCTION_ONLY_CUSTOM_BRAND');
  assert.equal(changedProd.realtimeEnabled,false);
  assert.equal(changedProd.memberLiffId,'1234567890-ProductionOnly');
  assert.deepEqual(testAfterProdMerge,changedTest,'production config edit must not change testing output');
  assert.notDeepEqual(changedProd,initialProd,'production edits must actually take effect in production');
  assert.notDeepEqual(changedTest,initialTest,'testing edits must actually take effect in testing');
 }finally{rmSync(fixture,{recursive:true,force:true});}
});

test('AC-016: malformed, secret-key or cross-project environment config blocks release',()=>{
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const fixture=mkdtempSync(path.join(tmpdir(),'config-profile-failure-'));
 try{
  for(const name of ['scripts','MemberWebsocket-dev'])cpSync(path.join(repo,name),path.join(fixture,name),{recursive:true,filter:p=>!p.split(path.sep).includes('node_modules')});
  const prodPath=path.join(fixture,'MemberWebsocket-dev/config/production/config.json');
  const source=JSON.parse(readFileSync(prodPath,'utf8'));
  const {PUBLIC_LIFF_CONFIG_PRODUCTION:excludedProd,PUBLIC_LIFF_CONFIG_TEST:excludedTest,...baseEnv}=process.env;
  const assertBuildFails=(changes,pattern)=>{
   writeFileSync(prodPath,JSON.stringify({...source,...changes}));
   const run=spawnSync(process.execPath,['scripts/build-site.mjs'],{cwd:fixture,encoding:'utf8',env:{...baseEnv,BRANCH:'master',CONTEXT:'production'}});
   assert.notEqual(run.status,0,'malformed profile must not create a deployable bundle');
   assert.match(run.stderr,pattern);
  };
  assertBuildFails({supabaseUrl:testing},/Cross-environment Supabase URL in production deployment config/);
  assertBuildFails({supabasePublishableKey:'sb_secret_dont_publish'},/Invalid production publishable key/);
  assertBuildFails({memberLiffId:'invalid'},/Invalid production: expected exactly seven LIFF IDs/);
  assertBuildFails({unrecognized:'123'},/Invalid production deployment config/);
 }finally{rmSync(fixture,{recursive:true,force:true});}
});

test('AC-CONFIG-FOLDER-001: build never reads the outer legacy config.json',()=>{
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const fixture=mkdtempSync(path.join(tmpdir(),'source-config-ignore-'));
 try {
  for(const name of ['scripts','MemberWebsocket-dev'])
   cpSync(path.join(repo,name),path.join(fixture,name),{recursive:true,filter:p=>!p.split(path.sep).includes('node_modules')});
  writeFileSync(path.join(fixture,'MemberWebsocket-dev/config.json'),'NOT VALID JSON AND MUST NEVER BE READ');
  for(const [branch,context,expected] of [
    ['master','production',environmentProfile('master')],
    ['Integrated-Marketing-Platform','branch-deploy',{...environmentProfile('Integrated-Marketing-Platform'),pricePublishing:true}]
  ]){
    const run=spawnSync(process.execPath,['scripts/build-site.mjs'],{
      cwd:fixture,encoding:'utf8',env:{...process.env,BRANCH:branch,CONTEXT:context,COMMIT_REF:'b'.repeat(40)}
    });
    assert.equal(run.status,0,run.stderr);
    const published=JSON.parse(readFileSync(path.join(fixture,'dist/config/config.json'),'utf8'));
    assert.deepEqual(published,expected,branch+' must use only config/'+(branch==='master'?'production':'testing')+'/config.json');
    assert.deepEqual(JSON.parse(readFileSync(path.join(fixture,'dist/config.json'),'utf8')),published);
    assert.equal(readdirSync(path.join(fixture,'dist/config')).length,1,'must publish only chosen config profile');
  }
 } finally {rmSync(fixture,{recursive:true,force:true});}
});
