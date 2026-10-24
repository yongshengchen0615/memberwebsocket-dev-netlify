const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const coverage = require('../e2e-feature-coverage.js');
const backend = import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(
  path.join(__dirname,'../supabase/functions/_shared/e2e-coverage.js'),'utf8')).toString('base64'));
const modules = ['member','points','event','calendar','integration','booking'];

function fixture(selectedModules, participantCount = 2) {
  const cases = ['ADMIN_A','UNIFIED_SERVER_FULL_E2E','PAIRED_COMPLEX_FIXTURE_PREPARE','PAIRED_HUMAN_INTERACTION_COVERAGE',
    ...(selectedModules.includes('member') ? ['PAIRED_MEMBER_REFERRAL_REWARD'] : []),
    ...(selectedModules.includes('points') ? ['PAIRED_POINT_TRANSFER_ATOMIC'] : []),
    ...(selectedModules.includes('event') ? ['PAIRED_EVENT_LAST_TICKET_RACE'] : []),
    ...(selectedModules.includes('booking') ? ['PAIRED_SECURITY_BOOKING_IDOR'] : [])].map(key => ({key,status:'passed'}));
  const clientCoverage = [];
  for (let participant = 1; participant <= participantCount; participant++) {
    for (const surface of selectedModules.filter(key => key !== 'integration')) {
      cases.push({key:`PAIRED_${participant}_${surface.toUpperCase()}`,status:'passed',
        actual:{coverageComplete:true,sameTestMember:true,humanInteractionVerified:true}});
      clientCoverage.push({participant,surface,coverage:{complete:true}});
    }
    if (selectedModules.some(key => key !== 'integration')) cases.push({key:`PAIRED_${participant}_ADMIN_RECORD_SYNC`,status:'passed'});
  }
  return {selectedModules,participantCount,adminKeys:['ADMIN_A'],cases,featureCoverage:{complete:true},clientCoverage};
}

test('all 63 selected scopes require every selected page for each of 1, 2 and 10 members', async () => {
  const {evaluateSelectedScope} = await backend;
  for (let mask = 1; mask < 64; mask++) for (const count of [1,2,10]) {
    const selected = modules.filter((_,index) => mask & (1 << index));
    const input = fixture(selected,count);
    const result = evaluateSelectedScope(input);
    assert.equal(result.complete,true,JSON.stringify(result));
    assert.equal(result.expectedClientSurfaces,count * selected.filter(key => key !== 'integration').length);
    // Delete each individual cell in turn; another member's success is no substitute.
    for (const evidence of input.clientCoverage) {
      assert.equal(evaluateSelectedScope({...input,clientCoverage:input.clientCoverage.filter(item => item !== evidence)}).complete,false);
    }
  }
});

test('null reports, duplicate cells, mismatched member, interrupted and unrun cases cannot pass', async () => {
  const {evaluateSelectedScope} = await backend;
  for (const mutation of [
    input => {input.featureCoverage = null;},
    input => {input.adminKeys = [];},
    input => {input.cases = input.cases.filter(row => row.key !== 'ADMIN_A');},
    input => {input.clientCoverage[0].coverage = null;},
    input => {input.clientCoverage.push(input.clientCoverage[0]);},
    input => {input.cases.find(row => row.actual).actual.sameTestMember = false;},
    input => {input.cases.find(row => row.actual).actual.cancelled = true;},
    input => {input.cases.push({key:'ADMIN_A',status:'skipped'});},
    input => {input.cases = input.cases.filter(row => row.key !== 'PAIRED_POINT_TRANSFER_ATOMIC');},
    input => {input.cases = input.cases.filter(row => row.key !== 'PAIRED_2_ADMIN_RECORD_SYNC');},
    input => {input.selectedModules = ['unknown'];},
  ]) {
    const input = fixture(modules); mutation(input);
    assert.equal(evaluateSelectedScope(input).complete,false);
  }
});

test('registered nodes outside the editorial feature inventory remain mandatory', () => {
  const keys = coverage.catalog.filter(item => item.side === 'user' || item.side === 'both')
    .filter(item => item.module === 'shared' || item.module === 'member').flatMap(item => item.user);
  keys.push('NEW_UNCATALOGUED_FEATURE');
  const input = {side:'user',modules:['member'],registeredKeys:keys,plannedKeys:keys,
    results:keys.map(key => ({key,status:'passed'}))};
  assert.equal(coverage.report(input).complete,true);
  for (const status of ['skipped','failed','running','cancelled']) {
    const result = coverage.report({...input,results:input.results.map(row => row.key === keys.at(-1) ? {...row,status} : row)});
    assert.equal(result.complete,false);
    assert.equal(result.counts.passed,result.total,'passing inventory cannot hide an unexecuted node');
  }
  assert.equal(coverage.report({...input,results:input.results.slice(0,-1)}).complete,false);
  assert.equal(coverage.report({...input,plannedKeys:keys.slice(0,-1)}).complete,false);
});

test('record normalization preserves execution incompleteness despite passing feature counts', async () => {
  const {normalizeFeatureCoverage} = await backend;
  const report = {total:1,counts:{passed:1},execution:{total:2,passed:1,complete:false}};
  assert.equal(normalizeFeatureCoverage(report).complete,false);
  assert.equal(normalizeFeatureCoverage(report).execution.complete,false);
});

test('invalid participant/surface evidence is discarded instead of being assigned to another cell', async () => {
  const {normalizeClientFeatureCoverage,normalizeFeatureCoverage} = await backend;
  assert.deepEqual(normalizeClientFeatureCoverage([{participant:0,surface:'member',coverage:{total:1,counts:{passed:1}}}]),[]);
  assert.deepEqual(normalizeClientFeatureCoverage([{participant:1,surface:'unknown',coverage:{total:1,counts:{passed:1}}}]),[]);
  assert.deepEqual(normalizeClientFeatureCoverage(Array(51).fill({participant:1,surface:'member'})),[]);
  const input = {total:1,counts:{passed:1},execution:{total:2,passed:2,complete:true}};
  const normalized = normalizeFeatureCoverage(input);
  assert.equal(normalized.complete,true);
  assert.deepEqual(normalizeFeatureCoverage(normalized),normalized);
});

test('the real coordinator fails an otherwise passed backend run containing skipped evidence', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname,'../admin/e2e-control.js'),'utf8').replace(
    '  window.MemberAdminE2EControl =', '  window.probe={state,runUnifiedServerFullPhase};\n  window.MemberAdminE2EControl =');
  for (const [passedCases,skippedCases,expected] of [[2,0,'passed'],[1,1,'failed']]) {
    const window = {addEventListener(){},MemberAdminTestControl:{runFull:async()=>({run:{status:'passed',totalCases:2,passedCases,skippedCases}})}};
    vm.runInNewContext(source,{window,document:{},performance,console});
    await window.probe.runUnifiedServerFullPhase(['member']);
    assert.equal(window.probe.state.results[0].status,expected);
  }
});
