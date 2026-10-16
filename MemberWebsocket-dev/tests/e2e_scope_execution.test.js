const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const graph = require('../e2e-scenario-graph.js');
const source = fs.readFileSync(process.env.E2E_SCOPE_SOURCE || path.join(__dirname, '../admin/e2e-control.js'), 'utf8');
const modules = ['member', 'points', 'event', 'calendar', 'integration', 'booking'];
const tick = () => new Promise(resolve => setImmediate(resolve));

function runner() {
  const replaceable = ['sleep', 'render', 'renderParticipants', 'adminSession', 'postPublicTestMode',
    'acquireE2ECleanupLease', 'recyclePreviousE2ERuntime', 'releaseE2ECleanupLease',
    'runUnifiedServerFullPhase', 'loadE2EProfile', 'prepareComplexE2EFixtures', 'prepareTestAccounts',
    'planAdminDefinitions', 'adminDefinitions', 'createPairedSession', 'seedParticipantSession',
    'runUserSurface', 'runPairedAdminBookingLive', 'verifyUserRunsVisibleInAdmin',
    'pairedMemberReferralRewardCase', 'pairedPointTransferAtomicCase', 'pairedEventLastTicketRaceCase',
    'bookingOwnershipBoundaryCase', 'runDeepPairedSuite', 'pairedHumanInteractionCoverageCase',
    'finalizeFeatureCoverage', 'recordResultRows', 'buildReplayManifest', 'attachFailureScreenshot'];
  const injected = source.replace('  window.MemberAdminE2EControl =', `
    window.probe = { state, runPaired, executeCases, runParticipantSurfaces,
      configure(overrides) { ${replaceable.map(key => `if (overrides.${key}) ${key} = overrides.${key};`).join('\n')} }
    };
    window.MemberAdminE2EControl =`);
  const timers = new Map(); let timerId = 0;
  const window = { addEventListener() {}, location: { href: 'https://example.test/admin/', search: '' },
    setTimeout: (callback, delay) => setTimeout(callback, delay === 5000 ? 10 : delay), clearTimeout,
    setInterval(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id), MemberE2EScenarioGraph: graph };
  vm.runInNewContext(injected, { window, document: {}, performance, console, URL, URLSearchParams });
  const probe = window.probe;
  probe.configure({ sleep: async () => {}, render() {}, renderParticipants() {}, attachFailureScreenshot: async () => {} });
  return { ...probe, window, timers };
}

function successfulChild(participant, surface) {
  return { ok: true, account: participant.account, coverage: { complete: true },
    summary: { passed: 1, failed: 0, total: 1 }, browserRun: { runCode: surface },
    humanInteraction: { requiredCases: 1, passedCases: 1, missingEvidenceKeys: [] } };
}

function coordinator({ selected = modules, count = 1, preflightFailure = 'ADMIN_BOOKING_CONTROLS',
  failedSurface = '', throwSurface = '', cancelSurface = '', stopInBackend = false, pendingAdmin = null } = {}) {
  const probe = runner(), visited = [], adminVisited = [], records = [], windows = [], releases = [], deepRuns = [];
  const passed = () => ({ status: 'passed', actual: {} });
  const definitions = ['ADMIN_AUTH_READY', 'ADMIN_BOOKING_CONTROLS', 'ADMIN_BOOKING_SHARED_SETTINGS',
    'ADMIN_MEMBER_CHECK', 'ADMIN_INTEGRATION_CHECK'].map(key => ({ key, name: key, run: async () => {
      adminVisited.push(key);
      return key === preflightFailure ? { status: 'failed', actual: {} } : passed();
    } }));
  const accounts = Array.from({ length: count }, (_, index) => ({ memberId: 'test-member-' + index, memberCode: 'T' + index }));
  probe.configure({
    adminSession: async () => ({ idToken: 'fixture', config: {} }),
    postPublicTestMode: async () => ({ maintenanceEnabled: true }),
    acquireE2ECleanupLease: async () => 'lease', recyclePreviousE2ERuntime: async () => ({}),
    releaseE2ECleanupLease: async id => { releases.push(id); return true; },
    runUnifiedServerFullPhase: async () => { if (stopInBackend) probe.state.cancelled = true; return {}; },
    loadE2EProfile: async () => { probe.state.clientConcurrency = count; return {}; },
    prepareComplexE2EFixtures: async () => ({}), prepareTestAccounts: async () => accounts,
    planAdminDefinitions: () => definitions, adminDefinitions: () => definitions,
    createPairedSession: async account => ({ account }), seedParticipantSession() {},
    runUserSurface: async (participant, surface) => {
      visited.push(participant.index + ':' + surface);
      if (pendingAdmin) probe.state.pendingTimedOutNode = pendingAdmin;
      if (surface === cancelSurface) probe.state.cancelled = true;
      if (surface === throwSurface) throw new Error('surface fixture failure');
      const child = successfulChild(participant, surface);
      if (surface === failedSurface) child.ok = false;
      return child;
    },
    runPairedAdminBookingLive: async () => null,
    verifyUserRunsVisibleInAdmin: async () => passed(),
    pairedMemberReferralRewardCase: async () => passed(), pairedPointTransferAtomicCase: async () => passed(),
    pairedEventLastTicketRaceCase: async () => passed(), bookingOwnershipBoundaryCase: async () => passed(),
    runDeepPairedSuite: async () => { deepRuns.push(true); }, pairedHumanInteractionCoverageCase: async () => passed(),
    finalizeFeatureCoverage: () => { probe.state.featureCoverage = { complete: false }; },
    buildReplayManifest: () => null,
    recordResultRows: async (...args) => { records.push(JSON.parse(JSON.stringify(args))); return { run: { runCode: 'RECORDED' } }; }
  });
  for (let i = 0; i < count; i++) windows.push({ closed: false, close() { this.closed = true; } });
  return { probe, visited, adminVisited, records, releases, deepRuns,
    run: () => probe.runPaired({ participantCount: count, selectedModules: selected, clientWindows: windows }) };
}

test('all checked modules execute for every member despite a failed booking preflight or client surface', async () => {
  for (const count of [1, 2, 10]) {
    const fixture = coordinator({ count, failedSurface: 'points', throwSurface: 'event' });
    const result = await fixture.run();
    assert.equal(result.error, undefined);
    assert.equal(result.cancelled, false);
    assert.equal(fixture.visited.length, count * 5);
    for (let index = 1; index <= count; index++) for (const surface of modules.filter(key => key !== 'integration')) {
      assert.ok(fixture.visited.includes(index + ':' + surface));
    }
    assert.ok(fixture.adminVisited.includes('ADMIN_INTEGRATION_CHECK'));
    assert.equal(result.results.find(row => row.key === 'ADMIN_BOOKING_CONTROLS').status, 'failed');
    assert.equal(fixture.records.length, 1);
  }
});

test('an unfinished admin action retains the purge lease and blocks the deep suite until cleanup settles', async () => {
  let resolve;
  const pendingAdmin = new Promise(done => { resolve = done; });
  const fixture = coordinator({ preflightFailure: '', pendingAdmin });
  await fixture.run();
  assert.equal(fixture.visited.length, 5);
  assert.equal(fixture.deepRuns.length, 0);
  assert.equal(fixture.releases.length, 0);
  resolve(); await tick();
  assert.deepEqual(fixture.releases, ['lease']);
});

test('authentication failure still prevents all member mutations and records every unexecuted scope', async () => {
  const fixture = coordinator({ preflightFailure: 'ADMIN_AUTH_READY' });
  const result = await fixture.run();
  assert.equal(result.error.code, 'E2E_ADMIN_PREFLIGHT_FAILED');
  assert.equal(fixture.visited.length, 0);
  assert.equal(fixture.records.length, 1);
  for (const surface of modules.filter(key => key !== 'integration')) {
    const row = result.results.find(row => row.key === 'PAIRED_1_' + surface.toUpperCase());
    assert.equal(row.actual.executed, false);
    assert.equal(row.status, 'failed');
  }
});

test('stopping in a surface or before clients start persists an incomplete report without a replay claim', async () => {
  for (const options of [{ cancelSurface: 'points' }, { stopInBackend: true }]) {
    const fixture = coordinator({ ...options, preflightFailure: '' });
    const result = await fixture.run();
    assert.equal(result.cancelled, true);
    assert.equal(fixture.records.length, 1);
    assert.equal(fixture.records[0][5].rootRun, false);
    assert.ok(result.results.some(row => row.actual?.code === 'E2E_SCOPE_NOT_EXECUTED'));
  }
});

test('an admin timeout drains cooperative cleanup and executes subsequent nodes without cancelling clients', async () => {
  const probe = runner(); let release, next = 0;
  const pending = new Promise(resolve => { release = resolve; });
  probe.window.MemberE2EScenarioGraph = { runWithDeadline: async (run, delay, key, onTimeout) => {
    if (key !== 'TIMEOUT') return run();
    onTimeout(pending);
    queueMicrotask(release);
    throw Object.assign(new Error('deadline'), { code: 'E2E_NODE_TIMEOUT' });
  } };
  await probe.executeCases([{ key: 'TIMEOUT', run() {} }, { key: 'NEXT', run: async () => { next++; return { status: 'passed' }; } }]);
  assert.equal(next, 1);
  assert.equal(probe.state.cancelled, false);
  assert.equal(probe.state.results[0].status, 'failed');
  assert.equal(probe.state.results[1].status, 'passed');
});

test('an unresolved admin mutation blocks other admin mutations but every independent client surface still executes', async () => {
  const probe = runner(); let resolve, next = 0;
  const pending = new Promise(done => { resolve = done; });
  probe.window.MemberE2EScenarioGraph = { runWithDeadline: async (run, delay, key, onTimeout) => {
    if (key !== 'TIMEOUT') return run();
    onTimeout(pending);
    throw Object.assign(new Error('deadline'), { code: 'E2E_NODE_TIMEOUT' });
  } };
  try {
    await probe.executeCases([{ key: 'TIMEOUT', run() {} }, { key: 'NEXT', run: () => { next++; } }]);
    assert.equal(next, 0);
    assert.equal(probe.state.results[1].actual.code, 'E2E_ADMIN_NODE_DRAINING');
    const visited = [];
    probe.state.selectedModules = modules;
    probe.configure({ createPairedSession: async () => ({}), seedParticipantSession() {},
      runUserSurface: async (participant, surface) => { visited.push(surface); return successfulChild(participant, surface); },
      runPairedAdminBookingLive: async () => null });
    await probe.runParticipantSurfaces({ index: 1, account: { memberId: 'test' }, runCodes: [] });
    assert.equal(visited.length, 5);
    assert.equal(probe.state.cancelled, false);
  } finally { resolve(); await tick(); }
});
