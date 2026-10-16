const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const graph = require('../e2e-scenario-graph.js');

function seeded(seed) {
  let state = 2166136261;
  for (const char of String(seed)) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  state >>>= 0;
  return () => {
    let x = state || 0x9e3779b9;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    state = x >>> 0;
    return state / 4294967296;
  };
}

function nodes(count = 16) {
  return Array.from({ length: count }, (_, index) => ({
    key: 'N' + index,
    name: 'Node ' + index,
    domain: index % 2 ? 'UI' : 'API'
  }));
}

test('scenario graph is deterministic for the same seed and changes route for another seed', () => {
  const source = nodes();
  const meta = {
    N0: { required: true, phase: 0 },
    N1: { required: true, phase: 1, dependencies: ['N0'] },
    N6: { dependencies: ['N1'] },
    N9: { dependencies: ['N6'] }
  };
  const a = graph.planScenario({ nodes: source, metaByKey: meta, randomUnit: seeded('alpha'), seed: 'alpha', complexityLevel: 4, minNodes: 10, maxNodes: 14 });
  const b = graph.planScenario({ nodes: source, metaByKey: meta, randomUnit: seeded('alpha'), seed: 'alpha', complexityLevel: 4, minNodes: 10, maxNodes: 14 });
  const c = graph.planScenario({ nodes: source, metaByKey: meta, randomUnit: seeded('beta'), seed: 'beta', complexityLevel: 4, minNodes: 10, maxNodes: 14 });
  assert.deepEqual(a.keys, b.keys);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.notDeepEqual(a.keys, c.keys);
});

test('scenario graph preserves dependency order and minimum breadth', () => {
  const source = nodes(18);
  const plan = graph.planScenario({
    nodes: source,
    metaByKey: {
      N0: { required: true, phase: 0 },
      N3: { required: true, phase: 3, dependencies: ['N2'] },
      N2: { phase: 2, dependencies: ['N1'] },
      N1: { phase: 1, dependencies: ['N0'] }
    },
    randomUnit: seeded('deps'),
    seed: 'deps',
    complexityLevel: 6,
    minNodes: 10,
    maxNodes: 14
  });
  assert.ok(plan.keys.length >= 10);
  for (const [before, after] of [['N0','N1'], ['N1','N2'], ['N2','N3']]) {
    assert.ok(plan.keys.indexOf(before) < plan.keys.indexOf(after), before + ' must precede ' + after);
  }
});

test('admin and user runners publish replayable scenario path artifacts', () => {
  const root = path.join(__dirname, '..');
  const admin = fs.readFileSync(path.join(root, 'admin/e2e-control.js'), 'utf8');
  const user = fs.readFileSync(path.join(root, 'user-test-control.js'), 'utf8');
  assert.match(admin, /function planAdminDefinitions\(/);
  assert.match(admin, /PAIRED_ADMIN_SCENARIO_PATH/);
  assert.match(admin, /ADMIN_NODE_META/);
  assert.match(admin, /MemberE2EScenarioGraph/);
  assert.match(user, /function planUserScenario\(/);
  assert.match(user, /QA_SCENARIO_PATH/);
  assert.match(user, /USER_NODE_META/);
  assert.match(user, /scenarioFingerprint/);
  assert.match(user, /MemberE2EScenarioGraph/);
});
