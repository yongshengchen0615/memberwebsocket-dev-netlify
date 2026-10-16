const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const professional = require('../e2e-professional-tester.js');
const graph = require('../e2e-scenario-graph.js');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('professional tester uses historical learning without losing deterministic exploration', () => {
  let learned = null;
  for (let index = 0; index < 200; index += 1) {
    const plan = professional.planTesterBehavior({
      caseKey: 'BOOKING_HUMAN_LIFECYCLE',
      side: 'user',
      surface: 'booking',
      risk: 'mutation',
      complexityLevel: 3,
      seed: 'LEARNING-' + index,
      learning: {
        executions: 8,
        passCount: 3,
        failCount: 5,
        failureRate: 0.6,
        failureEwma: 0.8,
        flakyScore: 0.6,
        riskScore: 0.85,
        preferredTesterProfile: 'impatient',
        lastFailureFingerprint: 'E2E-TEST'
      }
    });
    if (plan.profileSource === 'historical-preference') {
      learned = plan;
      break;
    }
  }
  assert.ok(learned, 'at least one deterministic seed should select the learned profile');
  assert.equal(learned.profile, 'impatient');
  assert.equal(learned.complexityLevel, 5);
  assert.ok(learned.strategies.includes('historical-failure-replay'));
  assert.ok(learned.strategies.includes('risk-weighted-postcondition'));
  assert.ok(learned.strategies.includes('repeat-and-recovery-evidence'));
  assert.ok(learned.strategies.includes('refresh-persistence-evidence'));

  const replay = professional.planTesterBehavior({
    caseKey: 'BOOKING_HUMAN_LIFECYCLE',
    side: 'user',
    surface: 'booking',
    risk: 'mutation',
    complexityLevel: 3,
    seed: learned.caseKey + '-stable',
    learning: learned.learning
  });
  const replayAgain = professional.planTesterBehavior({
    caseKey: 'BOOKING_HUMAN_LIFECYCLE',
    side: 'user',
    surface: 'booking',
    risk: 'mutation',
    complexityLevel: 3,
    seed: learned.caseKey + '-stable',
    learning: learned.learning
  });
  assert.deepEqual(replay, replayAgain);
});

test('historical risk biases scenario order but full mode still executes every node', () => {
  const nodes = [
    { key: 'A', name: 'A' },
    { key: 'B', name: 'B' },
    { key: 'C', name: 'C' }
  ];
  const plan = graph.planScenario({
    nodes,
    metaByKey: {},
    seed: 'risk-order',
    complexityLevel: 3,
    coverageMode: 'full',
    minNodes: 3,
    maxNodes: 3,
    priorityByKey: { C: 1, A: 0, B: 0 },
    randomUnit: () => 0.4
  });
  assert.equal(plan.keys[0], 'C');
  assert.deepEqual([...plan.keys].sort(), ['A', 'B', 'C']);
  assert.equal(plan.path.find((row) => row.key === 'C').priority, 1);
});

test('adaptive QA v2 persists private learning state and refreshes it after runs', () => {
  const migration = read('supabase/migrations/20261005131714_adaptive_e2e_learning_v2.sql');
  assert.match(migration, /create table if not exists public\.e2e_case_learning_state/);
  assert.match(migration, /alter table public\.e2e_case_learning_state enable row level security/);
  assert.match(migration, /revoke all on table public\.e2e_case_learning_state from public, anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on table public\.e2e_case_learning_state to service_role/);
  assert.match(migration, /admin_refresh_e2e_case_learning/);
  assert.match(migration, /failure_ewma/);
  assert.match(migration, /flaky_score/);
  assert.match(migration, /preferred_tester_profile/);
  assert.match(migration, /last_failure_fingerprint/);
  const incremental = read('supabase/migrations/20261005132510_accumulate_adaptive_e2e_learning.sql');
  assert.match(incremental, /last_learned_run_id/);
  assert.match(incremental, /admin_accumulate_e2e_case_learning/);
  assert.match(incremental, /Ordinary test-data purge may remove raw E2E runs/);
  const purge = read('supabase/migrations/20261005174200_fix_test_purge_evolution_delete_guard.sql');
  assert.doesNotMatch(purge, /e2e_case_learning_state/);

  const adminApi = read('supabase/functions/test-control-api/index.ts');
  const userApi = read('supabase/functions/user-test-api/index.ts');
  assert.match(adminApi, /from\("e2e_case_learning_state"\)/);
  assert.match(adminApi, /caseLearning/);
  assert.match(adminApi, /admin_accumulate_e2e_case_learning/);
  assert.match(userApi, /admin_accumulate_e2e_case_learning/);
});

test('admin and user orchestration consume history for planning and professional tester behavior', () => {
  const admin = read('admin/e2e-control.js');
  const user = read('user-test-control.js');
  for (const source of [admin, user]) {
    assert.match(source, /member-e2e-learning-v2/);
    assert.match(source, /historicalLearning/);
    assert.match(source, /historicalPriorityMap/);
    assert.match(source, /priorityByKey: historicalPriorityMap\(\)/);
    assert.match(source, /learning: historicalLearning/);
  }
  assert.match(user, /riskScore/);
  assert.match(user, /adaptiveReplaySourceKeys/);
});
