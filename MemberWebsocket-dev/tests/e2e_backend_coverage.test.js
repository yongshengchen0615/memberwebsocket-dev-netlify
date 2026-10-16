const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const coverage = require('../e2e-feature-coverage.js');
const read = name => fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const backend = import('data:text/javascript;base64,'+Buffer.from(read('supabase/functions/_shared/e2e-coverage.js')).toString('base64'));

test('server distinguishes passed, failed and incomplete including empty and unknown outcomes',async()=>{
  const {summarizeE2EExecution:summary}=await backend;
  for(const [cases,status] of [[[],'incomplete'],[[{status:'passed'}],'passed'],[[{status:'passed'},{status:'skipped'}],'incomplete'],[[{status:'failed'},{status:'skipped'}],'failed'],[[{status:'queued'}],'incomplete']]) {
    const result=summary(cases);assert.equal(result.verificationStatus,status);assert.equal(result.coverageComplete,status==='passed');
  }
});

function fixtureDb(services=[{id:'qa-1'},{id:'qa-2'}],error=null) {
  const queries=[],inserts=[];
  return {queries,inserts,from(table){
    const query={select(){return this;},eq(key,value){queries.push([table,key,value]);return this;},order(){return this;},limit(){return Promise.resolve({data:services,error});},insert(rows){inserts.push([table,rows]);return Promise.resolve({error});}};
    return query;
  }};
}

test('service-rule fixture preparation rejects wrong provenance before any database access',async()=>{
  const {prepareE2EServiceRuleFixtures:prepare}=await backend;
  for(const fixture of [{runTag:'PAIR-1234',createdBy:'admin'}, {runTag:'../OTHER',createdBy:'qa:e2e:../other'},{runTag:'PAIR-1234',createdBy:'qa:e2e:other'}]) {
    const db=fixtureDb();await assert.rejects(prepare(db,fixture),/PROVENANCE_INVALID/);assert.equal(db.queries.length,0);assert.equal(db.inserts.length,0);
  }
});

test('any/all fixtures reference only active standalone services owned by the current QA run',async()=>{
  const {prepareE2EServiceRuleFixtures:prepare}=await backend;
  const fixture={runTag:'PAIR-1234',createdBy:'qa:e2e:pair-1234',today:'2026-10-04'};
  const db=fixtureDb();const result=await prepare(db,fixture);
  assert.equal(result.serviceRuleTickets,2);
  assert.deepEqual(db.queries,[['booking_services','created_by',fixture.createdBy],['booking_services','is_active',true],['booking_services','requires_companion_service',false]]);
  assert.equal(db.inserts.length,1);assert.equal(db.inserts[0][0],'event_tickets');
  assert.deepEqual(db.inserts[0][1].map(row=>row.required_service_match_mode),['any','all']);
  for(const row of db.inserts[0][1]) {assert.deepEqual(row.required_service_ids,['qa-1','qa-2']);assert.equal(row.created_by,fixture.createdBy);assert.equal(row.updated_by,fixture.createdBy);assert.equal(row.starts_on,fixture.today);assert.match(row.event_ticket_id,/^QA-EVT-PAIR-1234-RULE-/);}
  const missing=fixtureDb([{id:'only-one'}]);await assert.rejects(prepare(missing,fixture),/SERVICES_MISSING/);assert.equal(missing.inserts.length,0);
  await assert.rejects(prepare(fixtureDb(undefined,{message:'unavailable'}),fixture),/SERVICES_MISSING/);
});

test('UTF-8 record compaction preserves all 500 identities, statuses and artifact references',()=>{
  const cases=Array.from({length:500},(_,i)=>({key:'CASE_'+i,name:'測試案例 '+i,domain:'Booking',status:i%3?'passed':'failed',message:'詳細錯誤說明'.repeat(120),expected:{value:'預期'.repeat(1000)},actual:{value:'實際'.repeat(1000)},trace:i%3?undefined:{events:'追蹤'.repeat(4000),screenshot:{path:'runs/'+i+'.webp'},diagnosis:{code:'ASSERTION'}}}));
  const payload={cases,rootRun:true,replayManifest:{seed:'complete'},idToken:'fixture'};
  const fitted=coverage.compactRecordPayload(payload);
  assert.ok(new TextEncoder().encode(JSON.stringify(fitted)).byteLength<=320000);
  assert.deepEqual(fitted.cases.map(row=>[row.key,row.status]),cases.map(row=>[row.key,row.status]));
  assert.equal(fitted.rootRun,true);assert.deepEqual(fitted.replayManifest,payload.replayManifest);
  for(let i=0;i<500;i+=3)assert.equal(fitted.cases[i].trace.screenshot.path,'runs/'+i+'.webp');
  assert.equal(payload.cases[0].actual.value.length,2000);
  assert.throws(()=>coverage.compactRecordPayload({cases,replayManifest:{huge:'文'.repeat(400000)}}),{code:'E2E_RECORD_TOO_LARGE'});
});

test('history labels legacy passed-with-skips as incomplete without changing terminal run state',()=>{
  const window={addEventListener(){}};
  const source=read('admin/test-control.js').replace("  function suiteText(suite) {", "  window.probe={runVerificationStatus,statusText,statusClass};\n  function suiteText(suite) {");
  vm.runInNewContext(source,{window,document:{}});
  const {runVerificationStatus:status,statusText,statusClass}=window.probe;
  assert.equal(status({status:'passed',skippedCases:1}),'incomplete');
  assert.equal(status({status:'passed',summary:{verificationStatus:'incomplete'}}),'incomplete');
  assert.equal(status({status:'passed',summary:{skippedCases:1}}),'incomplete');
  assert.equal(status({status:'failed',skippedCases:1}),'failed');
  assert.equal(status({status:'running',skippedCases:1}),'running');
  assert.equal(statusText('incomplete'),'覆蓋未完成');assert.equal(statusClass('incomplete'),' is-skipped');
});

test('user record fits the existing 80 KB request limit without dropping full-suite cases',()=>{
  const cases=Array.from({length:60},(_,i)=>({key:'USER_'+i,status:'passed',message:'驗證'.repeat(800),actual:{rows:'票券'.repeat(2000)},expected:{success:true}}));
  const fitted=coverage.compactRecordPayload({cases,startedAt:'2026-10-04T00:00:00Z'},60000);
  assert.equal(fitted.cases.length,60);assert.ok(new TextEncoder().encode(JSON.stringify(fitted)).byteLength<=60000);
  assert.deepEqual(fitted.cases.map(row=>row.key),cases.map(row=>row.key));
});
