const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const read = name => fs.readFileSync(path.join(__dirname,'../supabase/functions',name),'utf8');
const coverage = import('data:text/javascript;base64,' + Buffer.from(read('_shared/e2e-coverage.js')).toString('base64'));

async function persist(timing, cases = [{key:'NODE_A',status:'passed'}]) {
  const inserts = [];
  const db = {rpc:async()=>({error:null}),from(table) {
    return {insert(value){this.value=value;inserts.push({table,value});return this;},select(){return this;},
      single:async()=>({data:{id:'run-id'},error:null}),
      then(resolve,reject){return Promise.resolve({error:null,data:table === 'automation_test_cases'
        ? this.value.map((row,index)=>({case_key:row.case_key,id:'case-'+index})) : []}).then(resolve,reject);}};
  }};
  const source = read('user-test-api/index.ts').replace(/^import .*;\r?\n/gm,'');
  const context = {...await coverage,crypto,console,Deno:{serve(){},env:{get(){return '';}}},
    summarizeE2EFailureDiagnoses:()=>({})};
  vm.runInNewContext(stripTypeScriptTypes(source,{mode:'transform'}) + '\nglobalThis.persist=persistBrowserQaRun;',context);
  await context.persist(db,{lineUserId:'test:qa',memberId:'test-member'},'member',cases,timing);
  return inserts.find(row => row.table === 'automation_test_runs').value;
}

test('member full run persists incomplete when the feature report or any expected node is missing',async()=>{
  for(const timing of [
    {},
    {featureCoverage:{total:1,counts:{passed:1}},expectedCaseKeys:['NODE_A','NODE_B']},
    {featureCoverage:{total:1,counts:{passed:1}},expectedCaseKeys:['NODE_A','NODE_A']},
    {featureCoverage:{total:1,counts:{passed:1}},expectedCaseKeys:['invalid input']},
  ]) {
    const run = await persist(timing);
    assert.equal(run.status,'failed');
    assert.equal(run.summary.coverageComplete,false);
    assert.equal(run.summary.verificationStatus,'incomplete');
  }
});

test('complete member full runs and explicitly requested quick runs retain their own suite and evidence',async()=>{
  const full = await persist({suite:'full',featureCoverage:{total:1,counts:{passed:1}},expectedCaseKeys:['NODE_A']});
  assert.equal(full.status,'passed');
  assert.equal(full.suite,'full');
  assert.equal(full.summary.coverageComplete,true);
  const quick = await persist({suite:'quick'});
  assert.equal(quick.status,'passed');
  assert.equal(quick.suite,'quick');
  assert.equal(quick.summary.coverageComplete,true);
});
