const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../admin/e2e-control.js'), 'utf8');
const startedAt = '2026-09-22T12:00:00.000Z';
const account = { memberId: 'test-member', memberCode: 'TEST-001' };
const booking = (id, fields = {}) => ({
  bookingId: id, memberId: account.memberId, memberCode: account.memberCode, memberNote: 'QA HUMAN E2E GROUP run',
  createdAt: startedAt, updatedAt: startedAt, status: 'pending', ...fields
});
const participant = () => ({
  index: 1, account,
  bookingResult: { account, bookingHandoff: { ready: true, memberId: account.memberId, bookingIds: ['complete', 'cancel', 'reject'] }, results: [
    { key: 'BOOKING_HUMAN_GROUP', actual: { bookingId: 'complete' } },
    { key: 'BOOKING_HUMAN_LIFECYCLE', actual: { bookingId: 'cancel' } }
  ] }
});

// Execute the real runner with IO substituted; no live accounts or database writes.
function harness(bookings = [], extra = {}) {
  const calls = [];
  const window = {
    addEventListener() {}, setTimeout: (callback) => setTimeout(callback, 0), clearTimeout,
    MemberE2EScenarioGraph: require('../e2e-scenario-graph.js')
  };
  const context = vm.createContext({ window, document: {}, performance, TextEncoder, AbortController, CSS: { escape: (x) => x }, ...extra });
  const expose = `
    window.qa = { state, pairedBookingCandidates, livePairedBookingSet, waitForLivePairedBookingTarget, pairedAdminBookingFollowupCase, mutateDetectedBooking, mutateDetectedBookingTechnician, rejectDetectedCancellation, approveDetectedCancellation, requestDetectedCancellationFromClient, runPaired, recordResultRows, bookingTerminalSnapshot, verifyPairedBookingTerminalState, verifyBookingClientTerminal, beginBookingRealtimeProbe, verifyBookingRealtimeSync };
    window.qa.install = (io) => {
      adminBookingBootstrapSnapshot = io.bootstrap;
      verifyDetectedBookingInCoreFilter = io.core;
      verifyDetectedBookingInCancellationFilter = io.cancellation;
      setDetectedBookingStatus = io.status;
      mutateDetectedBooking = io.modify;
      mutateDetectedBookingTechnician = io.modifyTechnician;
      rejectDetectedCancellation = io.keepCancellation;
      approveDetectedCancellation = io.approveCancellation;
      requestDetectedCancellationFromClient = io.rerequestCancellation;
      cancelDetectedBooking = io.cancel;
      waitAdminBookingSnapshot = io.snapshot;
      beginBookingRealtimeProbe = io.beginRealtime;
      verifyBookingRealtimeSync = io.realtime;
      verifyPairedBookingTerminalState = io.terminal;
      verifyBookingClientTerminal = io.clientTerminal;
    };
    window.qa.mutationIO = (io) => {
      openAdminBookingQueue = async () => {};
      waitAdminBookingSnapshot = io.snapshot;
      adminSession = async () => ({ idToken: 'test-stub' });
      postFunction = io.details;
    };
    window.qa.preflightIO = (fixture) => {
      selectedParticipantCount = () => 1;
      openClientWindows = () => [];
      adminSession = async () => ({});
      postPublicTestMode = async () => ({ maintenanceEnabled: false });
      prepareComplexE2EFixtures = fixture;
      recordRun = async () => null;
    };
    window.qa.recordIO = (post) => {
      adminSession = async () => ({ idToken: 'test-stub' });
      postFunction = post;
    };
    window.qa.stubHumanEvidence = () => {
      captureAdminHumanInteraction = async (run) => ({
        outcome: await run(),
        evidence: { eventCount: 1, eventTypes: ['unit-test'], targets: ['unit-harness'] }
      });
    };
    window.qa.stubHumanEvidence = () => {
      captureAdminHumanInteraction = async (run) => ({
        outcome: await run(),
        evidence: { eventCount: 1, eventTypes: ['unit-test'], targets: ['unit-harness'] }
      });
    };
  `;
  vm.runInContext(source.replace('  window.MemberAdminE2EControl =', expose + '\n  window.MemberAdminE2EControl ='), context);
  const qa = window.qa;
  qa.stubHumanEvidence();
  qa.state.runStartedAt = startedAt;
  const io = {
    bootstrap: async () => ({ bookings }),
    core: async (id, filter) => ({ ok: true, bookingId: id, filter }),
    cancellation: async (id, mode) => ({ ok: true, bookingId: id, mode }),
    status: async (id, label, note, status) => {
      calls.push(status);
      const row = bookings.find((row) => row.bookingId === id);
      if (row) row.status = status;
      return { ok: true, bookingId: id, actualStatus: status };
    },
    modify: async () => { calls.push('modify'); return { ok: true, persistedQuantity: 2 }; },
    modifyTechnician: async () => { calls.push('technician'); return { ok: true, persistedTechnicianId: 'tech-b' }; },
    keepCancellation: async (id) => {
      calls.push('keep');
      const row = bookings.find((item) => item.bookingId === id);
      if (row) {
        row.cancellationRequestedAt = null;
        row.cancellationReviewedAt = startedAt;
        row.cancellationDecision = 'rejected';
      }
      return { ok: true, bookingId: id, sourceStatus: row?.status || 'pending', status: row?.status || 'pending', cancellationDecision: 'rejected' };
    },
    rerequestCancellation: async (_participant, id) => {
      calls.push('rerequest');
      const row = bookings.find((item) => item.bookingId === id);
      if (row) {
        row.cancellationRequestedAt = startedAt;
        row.cancellationReviewedAt = null;
        row.cancellationDecision = null;
      }
      return { ok: true, bookingId: id, cancellationRequestedAt: startedAt };
    },
    approveCancellation: async (id) => {
      calls.push('approve');
      const row = bookings.find((item) => item.bookingId === id);
      if (row) {
        row.status = 'cancelled';
        row.cancellationReviewedAt = startedAt;
        row.cancellationDecision = 'approved';
      }
      return { ok: true, bookingId: id, status: 'cancelled', cancellationDecision: 'approved' };
    },
    cancel: async (row) => { calls.push('cancel'); row.status = 'cancelled'; row.cancellationReviewedAt = startedAt; return { ok: true, status: 'cancelled' }; },
    snapshot: async (id) => bookings.find((row) => row.bookingId === id),
    beginRealtime: async (_participant, id) => ({ bookingId: id, beforeRenderCount: 1 }),
    realtime: async (_participant, probe, _validator, expectedDisplayStatus) => ({
      ok: true, bookingId: probe.bookingId, beforeRenderCount: 1, afterRenderCount: 2,
      renderAdvanced: true, expectedDisplayStatus, actualDisplayStatus: expectedDisplayStatus,
      badgeMatches: true, dataMatches: true, manualRefreshUsed: false
    }),
    terminal: async () => ({
      ok: true,
      admin: { unresolved: [], missingIds: [] },
      client: { ok: true, uiSynchronized: true }
    }),
    clientTerminal: async () => ({ ok: true, uiSynchronized: true })
  };
  qa.install(io);
  return { qa, calls, io, context, window };
}

const cancellation = () => booking('cancel', { memberNote: 'QA HUMAN E2E run', cancellationRequestedAt: startedAt });
const rejection = () => booking('reject', { memberNote: 'QA STATE PACK pending tag' });

test('admin booking bootstrap snapshot uses the booking API endpoint', () => {
  const start = source.indexOf('async function adminBookingBootstrapSnapshot()');
  const end = source.indexOf('\n  function bookingCreatedMs', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /postFunction\('booking-api',\s*\{/);
  assert.match(body, /action:\s*'admin\.booking\.bootstrap'/);
  assert.doesNotMatch(body, /MemberSystem\.request/);
});

test('covers every admin booking action with independent observable results', async () => {
  const { qa, calls } = harness([booking('complete'), cancellation(), rejection()]);
  const result = await qa.pairedAdminBookingFollowupCase(participant());
  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['rejected', 'keep', 'confirmed', 'modify', 'technician', 'completed', 'rerequest', 'approve']);
  assert.equal(qa.state.results.length, 9);
  assert.ok(qa.state.results.every((row) => row.status === 'passed' && row.durationMs >= 0));
  for (const suffix of ['_CONFIRM', '_MODIFY', '_MODIFY_TECHNICIAN', '_COMPLETE', '_REJECT', '_KEEP_CANCELLATION', '_CANCEL', '_TERMINAL', '_RISK_SCAN']) {
    assert.equal(qa.state.results.find((row) => row.key.endsWith(suffix)).status, 'passed');
  }
  assert.equal(result.actual.rejected.actualStatus, 'rejected');
  assert.equal(result.actual.keptCancellation.cancellationDecision, 'rejected');
  assert.equal(result.actual.cancelled.cancellationDecision, 'approved');
});

test('missing cancellation request does not block confirm, modify or complete', async () => {
  const { qa, calls } = harness([booking('complete')]);
  const result = await qa.pairedAdminBookingFollowupCase(participant());
  assert.deepEqual(calls, ['confirmed', 'modify', 'technician', 'completed']);
  assert.equal(result.status, 'failed');
  assert.equal(qa.state.results.find((row) => row.key.endsWith('_CANCEL')).status, 'failed');
  assert.equal(qa.state.results.find((row) => row.key.endsWith('_COMPLETE')).status, 'passed');
});

test('missing completion booking still permits independent cancellation review', async () => {
  const { qa, calls } = harness([cancellation()]);
  const result = await qa.pairedAdminBookingFollowupCase(participant());
  assert.deepEqual(calls, ['keep', 'rerequest', 'approve']);
  assert.equal(result.status, 'failed');
  assert.equal(qa.state.results.find((row) => row.key.endsWith('_KEEP_CANCELLATION')).status, 'passed');
  assert.equal(qa.state.results.find((row) => row.key.endsWith('_CANCEL')).status, 'passed');
});

test('a modification error remains the root failure while technician, completion and cancellation stay independently testable', async () => {
  const { qa, calls, io } = harness([booking('complete'), cancellation(), rejection()]);
  io.modify = async () => { calls.push('modify'); throw new Error('conflict'); };
  qa.install(io);
  const result = await qa.pairedAdminBookingFollowupCase(participant());
  assert.deepEqual(calls, ['rejected', 'keep', 'confirmed', 'modify', 'technician', 'completed', 'rerequest', 'approve']);
  assert.equal(result.actual.confirmed.ok, true);
  assert.equal(qa.state.results.find((row) => row.key.endsWith('_MODIFY')).actual.message, 'conflict');
  assert.equal(qa.state.results.find((row) => row.key.endsWith('_MODIFY_TECHNICIAN')).status, 'passed');
  assert.equal(qa.state.results.find((row) => row.key.endsWith('_COMPLETE')).status, 'passed');
});

test('a failed confirmation must not modify or complete the booking', async () => {
  const { qa, calls, io } = harness([booking('complete'), cancellation(), rejection()]);
  io.status = async (id, label, note, status) => {
    if (status === 'confirmed') { calls.push('confirm-failed'); return { ok: false }; }
    calls.push(status);
    const row = [booking('noop')].find(() => false);
    void row;
    return { ok: true, bookingId: id, actualStatus: status };
  };
  qa.install(io);
  await qa.pairedAdminBookingFollowupCase(participant());
  assert.deepEqual(calls, ['rejected', 'keep', 'confirm-failed', 'rerequest', 'approve']);
});

test('stop after confirmation prevents all subsequent writes', async () => {
  const { qa, calls, io } = harness([booking('complete'), cancellation()]);
  io.status = async () => { calls.push('confirmed'); qa.state.cancelled = true; return { ok: true }; };
  qa.install(io);
  const result = await qa.pairedAdminBookingFollowupCase(participant());
  assert.equal(result.status, 'skipped');
  assert.deepEqual(calls, ['keep', 'confirmed']);
});

test('only exact user-run booking IDs belonging to the same test member are selected', () => {
  const { qa } = harness();
  const data = { bookings: [
    booking('complete'), booking('old-run'), booking('cancel', { memberCode: 'REAL-001' }),
    booking('cancel', { memberNote: 'ordinary booking' }),
    booking('cancel', { createdAt: '2026-09-21T00:00:00Z' })
  ] };
  assert.equal(qa.pairedBookingCandidates(data, participant()).length, 1);
  assert.equal(qa.pairedBookingCandidates(data, { ...participant(), bookingResult: { account: { memberId: 'other' } } }).length, 0);
  assert.equal(qa.pairedBookingCandidates(data, { ...participant(), account: {} }).length, 0);
});

test('live admin discovery can see same-run QA rows before the user handoff is complete', () => {
  const { qa } = harness();
  const p = participant();
  p.bookingResult = null;
  const rows = [
    booking('group-live', { memberNote: 'QA HUMAN E2E GROUP live' }),
    booking('pending-live', { memberNote: 'QA STATE PACK pending live' }),
    booking('cancel-live', { memberNote: 'QA STATE PACK cancel_requested live', cancellationRequestedAt: startedAt }),
    booking('foreign-live', { memberId: 'other', memberNote: 'QA STATE PACK pending foreign' }),
    booking('manual-live', { memberNote: 'ordinary booking' }),
    booking('old-live', { memberNote: 'QA STATE PACK pending old', createdAt: '2026-09-21T00:00:00Z' })
  ];
  assert.equal(qa.pairedBookingCandidates({ bookings: rows }, p).length, 0);
  const live = qa.pairedBookingCandidates({ bookings: rows }, p, { live: true });
  assert.deepEqual(Array.from(live, (row) => row.bookingId), ['group-live', 'pending-live', 'cancel-live']);
  const set = qa.livePairedBookingSet(live);
  assert.equal(set.ready, true);
  assert.equal(set.mutable.bookingId, 'group-live');
  assert.equal(set.rejectTarget.bookingId, 'pending-live');
  assert.equal(set.cancellationTarget.bookingId, 'cancel-live');
});

test('paired booking admin waits for the completed member handoff before mutation processing', () => {
  const handoffIndex = source.indexOf('participant.bookingResult = child;');
  const adminMutationIndex = source.indexOf('runPairedAdminBookingLive(participant)', handoffIndex);
  assert.ok(handoffIndex >= 0 && adminMutationIndex > handoffIndex);
  assert.match(source, /let pairedAdminBookingChain = Promise\.resolve\(\)/);
  assert.match(source, /pairedAdminBookingChain = Promise\.resolve\(\);/);
  assert.match(source, /await clientExecution;/);
  assert.doesNotMatch(source, /liveAdminTasks/);
  assert.match(source, /completeHandoffBeforeMemberUiReuse/);
});

test('the paired E2E runs the selected modules and gates booking collaboration', () => {
  assert.match(source, /async function runPaired\(options = \{\}\)/);
  assert.match(source, /surfacePlan:replaySource\?replaySurfacePlan\(replaySource\.surfacePlan,selectedModules\):weightedSurfacePlan\(profile,index\+1\)/);
  assert.match(source, /const allAdminDefinitions = planAdminDefinitions\('full', selectedModules\)/);
  assert.match(source, /if \(surface === 'booking'\) \{[\s\S]*participant\.bookingResult = child;/);
  assert.match(source, /runPairedAdminBookingLive\(participant\)/);
  assert.match(source, /await executeCases\(remainingAdminDefinitions, '管理端 · 其餘完整 E2E'\)/);
  assert.match(source, /await runDeepPairedSuite/);
  assert.match(source, /PAIRED_HUMAN_INTERACTION_COVERAGE/);
  assert.doesNotMatch(source, /bookingOnly|includeAdminSuite/);
});

test('the full handoff processes state-pack and other retained QA bookings as well as human bookings', async () => {
  const bookings = [booking('complete'), cancellation(),
    booking('state-pending', { memberNote: 'QA STATE PACK pending tag' }),
    booking('state-cancel', { memberNote: 'QA STATE PACK cancel_requested tag', cancellationRequestedAt: startedAt }),
    booking('api-group', { memberNote: 'QA automated group update' })];
  const p = participant();
  p.bookingResult.bookingHandoff.bookingIds = bookings.map((row) => row.bookingId);
  const { qa, io } = harness(bookings);
  io.terminal = () => qa.verifyPairedBookingTerminalState(p);
  qa.install(io);
  const result = await qa.pairedAdminBookingFollowupCase(p);
  assert.equal(result.status, 'passed');
  assert.ok(bookings.every((row) => ['completed', 'cancelled', 'rejected'].includes(row.status)));
  assert.equal(result.actual.remainingProcessed.length, 2);
  assert.equal(result.actual.terminal.admin.unresolved.length, 0);
  assert.equal(qa.state.results.filter((row) => row.key.includes('_REMAINING_')).length, 2);
});

test('a residual pending booking makes the final verdict fail even if primary steps passed', async () => {
  const { qa, io } = harness([booking('complete'), cancellation()]);
  io.terminal = async () => ({ ok: false, admin: { unresolved: [{ bookingId: 'leftover', status: 'pending' }] } });
  qa.install(io);
  const result = await qa.pairedAdminBookingFollowupCase(participant());
  assert.equal(result.status, 'failed');
  assert.equal(qa.state.results.find((row) => row.key.endsWith('_TERMINAL')).status, 'failed');
});

test('terminal verification rejects unresolved, missing, wrong-owner and unreviewed cancellation records', () => {
  const { qa } = harness();
  for (const fields of [{ status: 'pending' }, { status: 'confirmed' }, { status: 'cancelled', cancellationRequestedAt: startedAt }]) {
    assert.equal(qa.bookingTerminalSnapshot([booking('a', fields)], ['a'], account.memberId).ok, false);
  }
  assert.equal(qa.bookingTerminalSnapshot([], ['a'], account.memberId).ok, false);
  assert.equal(qa.bookingTerminalSnapshot([], [], account.memberId).ok, false);
  assert.equal(qa.bookingTerminalSnapshot([booking('a', { status: 'completed', memberId: 'other' })], ['a'], account.memberId).ok, false);
  assert.equal(qa.bookingTerminalSnapshot([booking('r', { status: 'rejected' })], ['r'], account.memberId).ok, true);
  const rows = [booking('a', { status: 'completed' }), booking('b', { status: 'cancelled', cancellationRequestedAt: startedAt, cancellationReviewedAt: startedAt })];
  assert.equal(qa.bookingTerminalSnapshot(rows, ['a', 'b'], account.memberId).ok, true);
});

test('completed admin records cannot pass while the member client is stale', async () => {
  const { qa, io } = harness([booking('complete', { status: 'completed' }), booking('cancel', { status: 'cancelled' })]);
  io.clientTerminal = async () => ({ ok: false, uiSynchronized: false });
  qa.install(io);
  const p = participant();
  p.bookingResult.bookingHandoff.bookingIds = ['complete', 'cancel'];
  const result = await qa.verifyPairedBookingTerminalState(p);
  assert.equal(result.admin.ok, true);
  assert.equal(result.ok, false);
});

test('an old client without a complete handoff cannot produce a passing terminal verdict', async () => {
  const { qa } = harness();
  const p = participant();
  delete p.bookingResult.bookingHandoff;
  const result = await qa.verifyPairedBookingTerminalState(p);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'complete-handoff-required');
});

test('client handoff includes all newly created QA sources and excludes previous or manual bookings', () => {
  const userSource = fs.readFileSync(path.join(__dirname, '../user-test-control.js'), 'utf8');
  const window = { location: { pathname: '/MemberWebsocket-dev/booking/' }, addEventListener() {} };
  vm.runInNewContext(userSource.replace('  window.MemberUserTestControl =',
    '  window.buildBookingHandoff = buildBookingHandoff;\n  window.MemberUserTestControl ='), { window });
  const rows = [booking('old'), booking('human'),
    booking('state', { memberNote: 'QA STATE PACK pending tag' }),
    booking('api', { memberNote: 'QA automated group create' }),
    booking('manual', { memberNote: 'ordinary appointment' })];
  const handoff = window.buildBookingHandoff(['old'], rows, account.memberId, startedAt);
  assert.deepEqual(Array.from(handoff.bookingIds), ['human', 'state', 'api']);
  assert.equal(handoff.ready, true);
  assert.throws(() => window.buildBookingHandoff(null, rows, account.memberId, startedAt));
  assert.throws(() => window.buildBookingHandoff([], null, account.memberId, startedAt));
});

test('maintenance must be enabled before any fixtures or accounts are created', async () => {
  const { qa } = harness();
  let created = false;
  qa.preflightIO(async () => { created = true; });
  const result = await qa.runPaired();
  assert.equal(result.error.code, 'TEST_MAINTENANCE_REQUIRED');
  assert.equal(created, false);
});

test('large paired reports retain every case within the server limit of 500 per run', async () => {
  const { qa } = harness();
  const payloads = [];
  qa.recordIO(async (slug, payload) => {
    assert.equal(slug, 'test-control-api');
    payloads.push(payload);
    return { run: { runCode: 'batch-' + payloads.length } };
  });
  const rows = Array.from({ length: 1185 }, (_, index) => ({
    key: 'case-' + index, status: index === 1184 ? 'failed' : 'passed', actual: { index }
  }));
  const result = await qa.recordResultRows(rows, 'paired-browser', 'full', account.memberId, startedAt);
  assert.deepEqual(payloads.map((payload) => payload.cases.length), [500, 500, 185]);
  assert.deepEqual(payloads.flatMap((payload) => Array.from(payload.cases, (row) => row.key)), rows.map((row) => row.key));
  assert.ok(payloads.every((payload) => payload.memberId === account.memberId && payload.startedAt === startedAt));
  assert.equal(payloads[2].cases[184].status, 'failed');
  assert.equal(result.runs.length, 3);
});


test('admin booking bootstrap polling is globally coalesced below the backend read limit', () => {
  const start = source.indexOf('async function adminBookingBootstrapSnapshot()');
  const end = source.indexOf('\n  function bookingCreatedMs', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(source, /const ADMIN_BOOKING_BOOTSTRAP_BASE_INTERVAL_MS = 3500/);
  assert.match(source, /const ADMIN_BOOKING_BOOTSTRAP_MAX_INTERVAL_MS = 8000/);
  assert.match(source, /function adminBookingBootstrapIntervalMs\(/);
  assert.match(source, /error\?\.code \|\| ''\) !== 'RATE_LIMITED'/);
  assert.match(source, /Math\.floor\(Date\.now\(\) \/ 60000\) \+ 1/);
  assert.match(source, /let adminBookingBootstrapInFlight = null/);
  assert.match(source, /let adminBookingBootstrapLastData = null/);
  assert.match(body, /if \(adminBookingBootstrapInFlight\) return adminBookingBootstrapInFlight/);
  assert.match(body, /await sleep\(waitMs\)/);
  assert.match(body, /adminBookingBootstrapLastData = data/);
  assert.match(body, /adminBookingBootstrapLastAt = Date\.now\(\)/);
});


test('live admin realtime probe waits for the same account window to be on booking and never hijacks another surface', () => {
  const start = source.indexOf('async function ensureBookingRealtimeClient(participant');
  const end = source.indexOf('\n  async function beginBookingRealtimeProbe', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /participant\.lastSurfaceKey !== 'booking'/);
  assert.match(body, /const child = participant\?\.window/);
  assert.match(body, /E2E_BOOKING_CLIENT_NOT_READY/);
  assert.doesNotMatch(body, /createPairedSession/);
  assert.doesNotMatch(body, /seedParticipantSession/);
  assert.doesNotMatch(body, /waitParticipantSurface/);
  assert.doesNotMatch(body, /navigateParticipant/);
});


test('booking client exposes a read-only realtime E2E probe without forcing refresh', () => {
  const bookingSource = fs.readFileSync(path.join(__dirname, '../booking/app.js'), 'utf8');
  const bookingIndex = fs.readFileSync(path.join(__dirname, '../booking/index.html'), 'utf8');
  assert.match(bookingSource, /bookingRenderCount/);
  assert.match(bookingSource, /getRenderCount/);
  assert.match(bookingSource, /getBookingSnapshot/);
  assert.match(bookingSource, /booking:bookings-rendered/);
  assert.match(bookingIndex, /app\.js\?v=booking-member-chat-20261003-1/);
});

test('full booking E2E requires human-style admin UI actions and per-action realtime member sync', () => {
  assert.match(source, /adminHumanClick/);
  assert.match(source, /adminHumanSelect/);
  assert.match(source, /adminHumanTextInput/);
  assert.match(source, /beginBookingRealtimeProbe/);
  assert.match(source, /verifyBookingRealtimeSync/);
  assert.match(source, /manualRefreshUsed: false/);
  assert.match(source, /RISK_SCAN/);
  assert.match(source, /realtimeEveryAdminAction: true/);
  assert.match(source, /risksDetected/);
  assert.match(source, /humanUiAction: true/);
});

test('runner wires the actual technician and cancellation-review controls', () => {
  assert.match(source, /修改此位技師/);
  assert.match(source, /data-participant-technician/);
  assert.match(source, /persistedTechnicianId/);
  assert.match(source, /reject-cancellation/);
  assert.match(source, /approve-cancellation/);
  assert.match(source, /requestDetectedCancellationFromClient/);
});

for (const grouped of [false, true]) {
  test(`modification verifies stored quantities, not just timestamps (${grouped ? 'group' : 'single'})`, async () => {
    let closed = false;
    let persistedQuantity = 1;
    const quantity = { value: '1', dispatchEvent() {} };
    const checked = { value: grouped ? 'service' : 'on', dataset: grouped ? {} : { bookingService: 'service' }, closest: () => ({ querySelector: () => quantity }) };
    const form = { querySelector: (selector) => {
      if (selector.includes(':checked')) return checked;
      if (selector === '[data-participant-item-rows]') return grouped ? {} : null;
      if (selector === 'button[type="submit"]') return { click: () => { closed = true; } };
      return null;
    } };
    const modal = { classList: { contains: () => closed }, querySelector: () => form };
    const card = { querySelectorAll: () => [{ textContent: grouped ? '修改此位項目' : '修改服務項目', click() {} }] };
    const document = { querySelector: () => card, getElementById: () => modal };
    const { qa } = harness([], { document, Event: class {} });
    qa.mutationIO({
      snapshot: async () => booking('complete', { updatedAt: 'changed', items: [{ serviceId: 'service', quantity: persistedQuantity }] }),
      details: async () => ({ bookingGroups: { complete: { participants: [{ items: [{ serviceId: 'service', quantity: persistedQuantity }] }] } } })
    });
    const failed = await qa.mutateDetectedBooking(booking('complete'));
    assert.equal(failed.updatedAtChanged, true);
    assert.equal(failed.ok, false);
    closed = false;
    quantity.value = '1';
    persistedQuantity = 2;
    const passed = await qa.mutateDetectedBooking(booking('complete'));
    assert.equal(passed.persistedQuantity, 2);
    assert.equal(passed.ok, true);
  });
}


test('admin item mutation avoids extending a booked technician when a safer participant exists', () => {
  assert.match(source, /Number\(item\?\.quantity \|\| 0\) >= 2/);
  assert.match(source, /!participant\?\.technicianId/);
  assert.match(source, /decrease-existing-quantity/);
  assert.match(source, /increase-unassigned-participant/);
  assert.match(source, /避免擴張已指定技師的預約時段/);
});

test('complete root recording retains every case together and refuses a partial oversized root',async()=>{
  const {qa}=harness();const payloads=[];
  qa.recordIO(async(_slug,payload)=>{payloads.push(payload);return {run:{runCode:'whole-root'}};});
  const rows=Array.from({length:185},(_,i)=>({key:'ROOT_'+i,status:i===0?'failed':'passed'}));
  await qa.recordResultRows(rows,'paired-browser','full','',startedAt,{rootRun:true,replayManifest:{seed:'same-run'}});
  assert.equal(payloads.length,1);assert.equal(payloads[0].cases.length,185);assert.equal(payloads[0].rootRun,true);
  assert.equal(payloads[0].replayManifest.seed,'same-run');
  await assert.rejects(qa.recordResultRows(Array.from({length:501},()=>rows[0]),'paired-browser','full','',startedAt,{rootRun:true}),{code:'E2E_ROOT_CASE_LIMIT'});
  assert.equal(payloads.length,1);
});
