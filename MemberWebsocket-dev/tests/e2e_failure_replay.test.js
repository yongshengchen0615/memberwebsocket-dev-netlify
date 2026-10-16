const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const graph = require(path.join(root, 'e2e-scenario-graph.js'));

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

test('stored E2E path replays exactly and validates dependencies/fingerprint', () => {
  const nodes = [
    { key: 'AUTH', name: 'auth', domain: 'Authentication' },
    { key: 'BOOT', name: 'boot', domain: 'API' },
    { key: 'UI', name: 'ui', domain: 'UI' },
    { key: 'MUTATE', name: 'mutate', domain: 'Human E2E' },
    { key: 'OPTIONAL', name: 'optional', domain: 'Validation' }
  ];
  const metaByKey = {
    AUTH: { phase: 0, required: true },
    BOOT: { phase: 1, required: true, dependencies: ['AUTH'] },
    UI: { phase: 2, dependencies: ['BOOT'] },
    MUTATE: { phase: 3, required: true, dependencies: ['UI'] },
    OPTIONAL: { phase: 2, dependencies: ['BOOT'] }
  };
  const planned = graph.planScenario({
    nodes, metaByKey, seed: 'REPLAY-SEED', complexityLevel: 4,
    minNodes: 4, maxNodes: 5, randomUnit: seeded(0x12345678)
  });
  const replayed = graph.replayScenario({
    nodes, metaByKey, seed: 'REPLAY-SEED', complexityLevel: 4,
    keys: planned.keys, expectedFingerprint: planned.fingerprint
  });
  assert.deepEqual(replayed.keys, planned.keys);
  assert.equal(replayed.fingerprint, planned.fingerprint);
  assert.equal(replayed.replay, true);

  assert.throws(() => graph.replayScenario({
    nodes, metaByKey, seed: 'REPLAY-SEED', complexityLevel: 4,
    keys: ['AUTH', 'BOOT', 'MUTATE']
  }), /missing dependency|required node/i);

  assert.throws(() => graph.replayScenario({
    nodes, metaByKey, seed: 'REPLAY-SEED', complexityLevel: 4,
    keys: planned.keys, expectedFingerprint: 'SG1-deadbeef'
  }), /fingerprint mismatch/i);
});

test('admin, user and server expose one-click failure replay contracts', () => {
  const admin = fs.readFileSync(path.join(root, 'admin/e2e-control.js'), 'utf8');
  const user = fs.readFileSync(path.join(root, 'user-test-control.js'), 'utf8');
  const control = fs.readFileSync(path.join(root, 'admin/test-control.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'supabase/functions/test-control-api/index.ts'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');

  assert.match(admin, /replayFailedRun/);
  assert.match(admin, /admin\.test-control\.replay-manifest/);
  assert.match(admin, /buildReplayManifest/);
  assert.match(admin, /planner\.replayScenario/);
  assert.match(admin, /member-e2e-replay-v1/);
  assert.match(admin, /replayOfRunId/);

  assert.match(user, /REPLAY_STORAGE_KEY = 'member-e2e-replay-v1'/);
  assert.match(user, /planner\.replayScenario/);
  assert.match(user, /adaptiveReplaySourceKeys/);
  assert.match(user, /randomStateAfterBuild/);

  assert.match(control, /重播失敗流程/);
  assert.match(control, /MemberAdminE2EControl/);
  assert.match(html, /Replay Manifest/);

  assert.match(api, /function normalizeReplayManifest/);
  assert.match(api, /function replaySourceRun/);
  assert.match(api, /action === "admin\.test-control\.replay-manifest"/);
  assert.match(api, /REPLAY_MANIFEST_DRIFT/);
  assert.match(api, /function replayComparison/);
  assert.match(api, /body\.rootRun === true && !sourceReplay/);
});

test('all E2E entry points use replay-capable cache versions', () => {
  assert.match(fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8'), /e2e-control\.js\?v=qa-e2e-\d{8}-\d+/);
  for (const surface of ['member', 'points', 'event', 'calendar', 'booking']) {
    const html = fs.readFileSync(path.join(root, surface, 'index.html'), 'utf8');
    assert.match(html, /e2e-scenario-graph\.js\?v=e2e-graph-20261004-\d+/);
    assert.match(html, /user-test-control\.js\?v=qa-e2e-\d{8}-\d+/);
  }
});
