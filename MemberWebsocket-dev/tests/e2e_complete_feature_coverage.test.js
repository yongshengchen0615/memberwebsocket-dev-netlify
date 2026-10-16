const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const graph = require('../e2e-scenario-graph.js');
const coverage = require('../e2e-feature-coverage.js');
const root = path.join(__dirname,'..');
const read = relative => fs.readFileSync(path.join(root,relative),'utf8');
const modules = ['member','points','event','calendar','integration','booking'];

function admin() {
  const context = {window:{addEventListener(){},MemberE2EScenarioGraph:graph},document:{},performance,console};
  const source = read('admin/e2e-control.js').replace('  window.MemberAdminE2EControl =',
    '  window.probe = {state,adminDefinitions,planAdminDefinitions,ADMIN_NODE_META,configureRandom};\n  window.MemberAdminE2EControl =');
  vm.runInNewContext(source,context);
  return context.window.probe;
}
function user(surface) {
  const context = {window:{addEventListener(){},location:{pathname:'/MemberWebsocket-dev/'+surface+'/',search:''},MemberE2EScenarioGraph:graph},document:{},performance,URLSearchParams,console};
  const source = read('user-test-control.js').replace('  window.MemberUserTestControl =',
    '  window.probe = {state,buildCases,USER_NODE_META};\n  window.MemberUserTestControl =');
  vm.runInNewContext(source,context);
  return context.window.probe;
}

test('full mode includes all nodes at every complexity and preserves dependency order',()=>{
  const nodes = Array.from({length:40},(_,i)=>({key:'N'+i}));
  const meta = {N1:{dependencies:['N0']},N39:{dependencies:['N1']}};
  for (let level=1;level<=8;level++) {
    const plan=graph.planScenario({nodes,metaByKey:meta,coverageMode:'full',complexityLevel:level,minNodes:2,maxNodes:4,randomUnit:()=>0.42});
    assert.equal(plan.keys.length,40);
    assert.equal(plan.coverageMode,'full');
    assert.ok(plan.keys.indexOf('N0')<plan.keys.indexOf('N1'));
    assert.ok(plan.keys.indexOf('N1')<plan.keys.indexOf('N39'));
  }
});

test('every selectable admin combination plans every registered node and feature',()=>{
  const runner=admin();
  for(let mask=1;mask<64;mask++) {
    const selected=modules.filter((_,i)=>mask&(1<<i));
    runner.state.selectedModules=selected;
    runner.configureRandom('complete-'+mask);
    const registered=Array.from(runner.adminDefinitions('full',selected),item=>item.key);
    const planned=Array.from(runner.planAdminDefinitions('full',selected),item=>item.key);
    assert.deepEqual([...planned].sort(),[...registered].sort(),selected.join(','));
    const report=coverage.report({side:'admin',modules:selected,registeredKeys:registered,plannedKeys:planned,results:planned.map(key=>({key,status:'passed'}))});
    assert.equal(report.complete,true,JSON.stringify(report.features.filter(item=>item.status!=='passed')));
    for (const key of planned) for(const dependency of runner.ADMIN_NODE_META[key]?.dependencies || [])
      assert.ok(planned.indexOf(dependency)<planned.indexOf(key),key+':'+dependency);
  }
});

test('all five user catalogs include every feature and optional node in full mode',()=>{
  for(const surface of modules.filter(item=>item!=='integration')) {
    const runner=user(surface);
    const cases=runner.buildCases('full');
    const keys=Array.from(cases,item=>item.key);
    const catalog=Array.from(runner.state.caseCatalogKeys);
    assert.equal(new Set(keys).size,keys.length);
    assert.ok(catalog.every(key=>keys.includes(key)),surface);
    const report=coverage.report({side:'user',modules:[surface],registeredKeys:catalog,plannedKeys:keys,results:keys.map(key=>({key,status:'passed'}))});
    assert.equal(report.complete,true,JSON.stringify(report.features.filter(item=>item.status!=='passed')));
    for(const key of keys) for(const dependency of runner.USER_NODE_META[key]?.dependencies || [])
      assert.ok(keys.indexOf(dependency)<keys.indexOf(key),key+':'+dependency);
  }
});

test('coverage distinguishes unregistered, unplanned, missing, blocked and failed evidence',()=>{
  const item=coverage.catalog.find(item=>item.id==='member.phone');
  const key=item.user[0];
  const probe=options=>coverage.report({side:'user',modules:['member'],...options}).features.find(row=>row.id===item.id);
  assert.equal(probe({}).status,'unregistered');
  assert.equal(probe({registeredKeys:[key]}).status,'unplanned');
  assert.equal(probe({registeredKeys:[key],plannedKeys:[key]}).status,'not-run');
  for(const [status,expected] of [['passed','passed'],['skipped','blocked'],['failed','failed'],['running','not-run'],['queued','not-run'],['cancelled','not-run'],['unknown','not-run']])
    assert.equal(probe({registeredKeys:[key],plannedKeys:[key],results:[{key,status}]}).status,expected);
  assert.equal(probe({registeredKeys:[key],plannedKeys:[key],results:[{key,status:'failed'},{key,status:'passed'}]}).status,'failed');
  for (const status of ['skipped','blocked','cancelled','running']) assert.notEqual(probe({registeredKeys:[key],plannedKeys:[key],results:[{key,status},{key,status:'passed'}]}).status,'passed');
});

test('new contract evidence keeps device and external-delivery limitations explicit',()=>{
  for(const id of ['member.join','event.birthday','event.fixed','tickets.location','booking.receipt','booking.accessible-admin'])
    assert.ok(coverage.catalog.find(item=>item.id===id).limitation,id);
  for(const entry of ['admin','member','points','event','calendar','booking']) {
    const html=read(entry+'/index.html');
    assert.ok(html.indexOf('e2e-feature-coverage.js')<html.indexOf('e2e-scenario-graph.js'),entry);
  }
});
