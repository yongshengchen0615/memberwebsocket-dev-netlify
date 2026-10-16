const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('admin E2E uses deterministic seed and bounded participant concurrency', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /function hashSeed\(/);
  assert.match(runner, /function nextRandomUnit\(/);
  assert.match(runner, /async function loadE2EProfile\(/);
  assert.match(runner, /async function runWithConcurrency\(/);
  assert.match(runner, /state\.clientConcurrency/);
  assert.match(runner, /async function loadE2EProfile\(participantCount = 1, modules = state\.selectedModules\)/);
  assert.match(runner, /participantFanout/);
  assert.match(runner, /participantConcurrencyCap/);
  assert.match(runner, /loadE2EProfile\(participantCount, selectedModules\)/);
  assert.match(runner, /admin\.test-control\.e2e-profile/);
  assert.match(runner, /e2eSeed/);
  assert.match(runner, /e2eComplexity/);
  assert.match(runner, /rootRun: true/);
  assert.match(runner, /function weightedSurfacePlan\(/);
  assert.match(runner, /surfacePlan:replaySource\?replaySurfacePlan\(replaySource\.surfacePlan,selectedModules\):weightedSurfacePlan\(profile,index\+1\)/);
});

test('user E2E consumes adaptive profile and adds deterministic safe replays', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /function configureRunProfile\(/);
  assert.match(runner, /e2eSeed/);
  assert.match(runner, /e2eComplexity/);
  assert.match(runner, /adaptiveReplays/);
  assert.match(runner, /_REPLAY_/);
  assert.match(runner, /Math\.max\(3, Math\.min\(7, 2 \+ Number\(state\.complexityLevel/);
});

test('test control API persists root-run evolution metadata', () => {
  const api = read('supabase/functions/test-control-api/index.ts');
  assert.match(api, /async function e2eProfile\(/);
  assert.match(api, /completedRootRuns/);
  assert.match(api, /nextComplexityLevel/);
  assert.match(api, /rootRun: body\.rootRun === true/);
  assert.match(api, /e2eSeed/);
  assert.match(api, /clientConcurrency/);
  assert.match(api, /surfaceWeightsMs/);
  assert.match(api, /surfaceSamples/);
  assert.match(api, /durationBuckets/);
  assert.match(api, /e2e_evolution_state/);
  assert.match(api, /admin_advance_e2e_evolution/);
});

test('E2E evolution state survives ordinary test-data purge', () => {
  const migration = read('supabase/migrations/20260923081500_persist_e2e_evolution_state.sql');
  assert.match(migration, /create table if not exists public\.e2e_evolution_state/);
  assert.match(migration, /admin_advance_e2e_evolution/);
  assert.match(migration, /last_root_run_id/);
  assert.match(migration, /grant select, insert, update on table public\.e2e_evolution_state to service_role/);
});

test('adaptive E2E asset versions and scenario graph are aligned across all surfaces', () => {
  assert.match(read('admin/index.html'), /e2e-scenario-graph\.js\?v=e2e-graph-20261004-\d+/);
  assert.match(read('admin/index.html'), /e2e-control\.js\?v=qa-e2e-\d{8}-\d+/);
  for (const surface of ['member', 'points', 'event', 'calendar', 'booking']) {
    assert.match(read(surface + '/index.html'), /e2e-scenario-graph\.js\?v=e2e-graph-20261004-\d+/);
    assert.match(read(surface + '/index.html'), /user-test-control\.js\?v=qa-e2e-\d{8}-\d+/);
  }
});
