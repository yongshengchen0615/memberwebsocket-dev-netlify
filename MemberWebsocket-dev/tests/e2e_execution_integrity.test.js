const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const { runWithDeadline } = require('../e2e-scenario-graph.js');

function adminProbe() {
  const window = { addEventListener() {} };
  vm.runInNewContext(read('admin/e2e-control.js').replace('  window.MemberAdminE2EControl =',
    '  window.executionProbe = { runWithConcurrency, state, retainTimedOutNode, waitFor, runPaired };\n  window.MemberAdminE2EControl ='),
  { window, document: {}, performance });
  return window.executionProbe;
}

test('parallel E2E failure drains active workers before cleanup and stops scheduling new fixtures', async () => {
  const { runWithConcurrency } = adminProbe();
  let release;
  const active = new Promise(resolve => { release = resolve; });
  const failure = new Error('original-worker-failure');
  const started = [];
  let settled = false;
  const task = runWithConcurrency([1, 2, 3, 4], 2, async item => {
    started.push(item);
    if (item === 1) throw failure;
    await active;
  });
  const result = task.then(() => ({ ok: true }), error => ({ error })).finally(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'cleanup must not begin while participant 2 is active');
  assert.deepEqual(started, [1, 2]);
  release();
  assert.equal((await result).error, failure);
  assert.deepEqual(started, [1, 2], 'queued participants must not create further fixtures');
});

test('parallel E2E cancellation drains current work without dispatching another participant', async () => {
  const probe = adminProbe();
  let release;
  const active = new Promise(resolve => { release = resolve; });
  const started = [];
  const task = probe.runWithConcurrency([1, 2, 3], 2, async item => { started.push(item); await active; });
  probe.state.cancelled = true;
  release();
  await task;
  assert.deepEqual(started, [1, 2]);
});

test('two user E2E starts cannot both pass a delayed session admission check', async () => {
  let release;
  let reads = 0;
  const window = {
    addEventListener() {}, location: { pathname: '/MemberWebsocket-dev/member/' },
    MemberSystem: { loadConfig: async () => ({}) },
    TestModeClient: { sessionStatus: () => { reads++; return new Promise(resolve => { release = resolve; }); } }
  };
  const document = { getElementById: () => null, documentElement: { classList: { remove() {} } } };
  vm.runInNewContext(read('user-test-control.js'), { window, document, performance });
  const first = window.MemberUserTestControl.runFull();
  await tick();
  assert.equal(window.MemberUserTestControl.isRunning(), true);
  assert.equal((await window.MemberUserTestControl.runFull()).busy, true);
  assert.equal(reads, 1);
  release(null);
  assert.equal((await first).reason, 'inactive-session');
  assert.equal(window.MemberUserTestControl.isRunning(), false);
});

test('structured HTTP failures take priority over words from the scenario title', async () => {
  const source = read('supabase/functions/_shared/e2e-diagnostics.js');
  const { diagnoseE2EFailure, findField } = await import('data:text/javascript;base64,' +
    Buffer.from(source + '\nexport { findField };').toString('base64'));
  for (const [status, code] of [[401, 'E2E_AUTHENTICATION'], [403, 'E2E_AUTHORIZATION'],
    [429, 'E2E_RATE_LIMIT'], [503, 'E2E_BACKEND']]) {
    assert.equal(diagnoseE2EFailure({ caseKey: 'REALTIME_SYNC',
      message: 'Realtime subscription timeout', actual: { httpStatus: status } }).code, code);
  }
  const route = diagnoseE2EFailure({ caseKey: 'RECEIPT', actual: { code: 'NOT_FOUND', httpStatus: 404 },
    trace: { apiTimings: [{ path: '/functions/v1/booking-receipt-api', responseStatus: 404 }] } });
  assert.equal(route.code, 'E2E_DEPLOYMENT_ROUTE');
  assert.equal(route.retryable, false);
  const missingReceipt = diagnoseE2EFailure({ caseKey: 'RECEIPT', actual: { code: 'RECEIPT_NOT_FOUND', httpStatus: 404 },
    trace: { apiTimings: [{ path: '/functions/v1/booking-receipt-api', responseStatus: 404 }] } });
  assert.notEqual(missingReceipt.code, 'E2E_DEPLOYMENT_ROUTE');
  assert.equal(diagnoseE2EFailure({ actual: { httpStatus: 503 }, trace: { apiTimings: [
    { path: '/functions/v1/api?testToken=sensitive', responseStatus: 503 }
  ] } }).signal.path, '/functions/v1/api');

  let visited = 0;
  const wide = {};
  for (let i = 0; i < 80; i++) {
    wide['branch' + i] = {};
    for (let j = 0; j < 80; j++) Object.defineProperty(wide['branch' + i], 'leaf' + j,
      { enumerable: true, get() { visited++; return {}; } });
  }
  wide.cycle = wide;
  assert.equal(findField(wide, new Set(['absent'])), null);
  assert.ok(visited <= 256 * 80, 'diagnosis has a shared traversal budget');
  assert.ok(visited < 6400, 'wide traces must not traverse every branch');
  assert.equal(findField({ cycle: wide, code: 'AUTH_REQUIRED' }, new Set(['code'])), 'AUTH_REQUIRED');
});

test('stopping during delayed admission cannot start fixtures after the session becomes ready', async () => {
  let release;
  const window = {
    addEventListener() {}, location: { pathname: '/MemberWebsocket-dev/member/' },
    MemberSystem: { loadConfig: async () => ({}) },
    TestModeClient: { sessionStatus: () => new Promise(resolve => { release = resolve; }) }
  };
  vm.runInNewContext(read('user-test-control.js'), { window, document: {}, performance });
  const pending = window.MemberUserTestControl.runFull();
  await tick();
  assert.equal(window.MemberUserTestControl.stop(), true);
  release({ active: true, account: { memberId: 'fixture-member' } });
  assert.equal((await pending).cancelled, true);
  assert.equal(window.MemberUserTestControl.isRunning(), false);
});

test('a timed out admin node blocks runner reuse until its original action settles', async () => {
  const probe = adminProbe();
  let release;
  const action = new Promise(resolve => { release = resolve; });
  await assert.rejects(runWithDeadline(() => action, 10, 'PENDING', probe.retainTimedOutNode),
    error => error.code === 'E2E_NODE_TIMEOUT');
  assert.equal((await probe.runPaired()).error.code, 'E2E_NODE_DRAINING');
  await assert.rejects(probe.waitFor(() => false), error => error.code === 'E2E_NODE_CANCELLED');
  release();
  await tick();
  assert.equal(probe.state.pendingTimedOutNode, null);
});

test('a timed out user node blocks a new suite and releases its guard after rejection', async () => {
  const window = { addEventListener() {}, location: { pathname: '/MemberWebsocket-dev/member/' } };
  vm.runInNewContext(read('user-test-control.js').replace('  window.MemberUserTestControl =',
    '  window.executionProbe = { state, retainTimedOutNode, waitFor };\n  window.MemberUserTestControl ='),
  { window, document: {}, performance });
  let reject;
  const action = new Promise((resolve, fail) => { reject = fail; });
  window.executionProbe.retainTimedOutNode(action);
  assert.equal((await window.MemberUserTestControl.runFull()).reason, 'timed-out-node-draining');
  await assert.rejects(window.executionProbe.waitFor(() => false), error => error.code === 'E2E_NODE_CANCELLED');
  reject(new Error('late original failure'));
  await tick();
  assert.equal(window.executionProbe.state.pendingTimedOutNode, null);
});
