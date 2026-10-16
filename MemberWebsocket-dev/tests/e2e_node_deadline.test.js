const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runWithDeadline } = require('../e2e-scenario-graph.js');

test('completed and failed nodes settle without invoking timeout cleanup', async () => {
  let stopped = 0;
  assert.equal(await runWithDeadline(() => Promise.resolve('passed'), 30, 'OK', () => stopped++), 'passed');
  await assert.rejects(runWithDeadline(() => Promise.reject(new Error('bad')), 30, 'BAD', () => stopped++), /bad/);
  assert.equal(stopped, 0);
});

test('a never settling node fails with its own key and stops its runner', async () => {
  let stopped = 0;
  await assert.rejects(
    runWithDeadline(() => new Promise(() => {}), 15, 'COMMON_TOUR_JOURNEY', () => stopped++),
    (error) => error.code === 'E2E_NODE_TIMEOUT' && error.nodeKey === 'COMMON_TOUR_JOURNEY'
  );
  assert.equal(stopped, 1);
});

test('both browser runners use a deadline around every case and retain timeout failures', () => {
  const root = path.resolve(__dirname, '..');
  const admin = fs.readFileSync(path.join(root, 'admin/e2e-control.js'), 'utf8');
  const user = fs.readFileSync(path.join(root, 'user-test-control.js'), 'utf8');
  assert.match(admin, /runWithDeadline\(async \(\) => \{[\s\S]*?def\.run\(\)/);
  assert.match(user, /runWithDeadline\(async \(\) => \{[\s\S]*?testCase\.run\(\)/);
  assert.match(admin, /if \(timedOut\) \{[\s\S]*?await drainTimedOutAdminNode\(\)/);
  assert.match(user, /if \(timedOutCase\) break/);
  assert.match(user, /state\.cancelled && !timedOutCase/);
});

test('closing a background runner settles the parent completion wait', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../admin/e2e-control.js'), 'utf8');
  const window = {
    addEventListener() {},
    setInterval(callback) { queueMicrotask(callback); return 1; },
    clearInterval() {}
  };
  const context = vm.createContext({ window, document: {}, performance });
  vm.runInContext(source.replace('  window.MemberAdminE2EControl =',
    '  window.deadlineProbe = { watchBackgroundCompletion, state };\n  window.MemberAdminE2EControl ='), context);
  window.deadlineProbe.state.backgroundLastStatusAt = Date.now();
  await assert.rejects(
    window.deadlineProbe.watchBackgroundCompletion(new Promise(() => {}), { closed: true }),
    (error) => error.code === 'E2E_BACKGROUND_RUNNER_CLOSED'
  );
});
