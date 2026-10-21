import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/test-memberwebsocket-dev.yml', import.meta.url), 'utf8');
const expectedLanes = [
  'regression', 'integration', 'postgres-integration', 'browser-e2e',
  'browser-syntax', 'edge-functions', 'wiring', 'dependency-audit',
];

test('every pull request triggers the entire regression workflow, regardless of changed paths', () => {
  const topLevel = workflow.split(/^permissions:/m)[0];
  const pr = topLevel.match(/^  pull_request:\s*\n([\s\S]*?)(?=^\S|$)/m);
  assert.ok(pr, 'pull_request event is required');
  assert.doesNotMatch(pr[1], /^\s+(?:paths|paths-ignore|branches|branches-ignore):/m);
});

test('all eight test lanes and the aggregate validation job remain present', () => {
  const jobs = workflow.split(/^jobs:\s*$/m)[1];
  assert.ok(jobs, 'jobs block is required');
  for (const name of [...expectedLanes, 'validate']) {
    assert.ok(new RegExp('^  ' + name + ':', 'm').test(jobs), name + ' must exist');
  }
  const aggregate = jobs.split(/^  validate:\s*$/m)[1];
  assert.ok(aggregate, 'aggregate validation must exist');
  assert.match(aggregate, /^    if: always\(\)/m);
  const needs = aggregate.match(/^    needs: \[([^\]]+)\]/m);
  assert.ok(needs, 'aggregate needs dependencies');
  assert.deepEqual(
    new Set(needs[1].split(',').map((name) => name.trim())),
    new Set(expectedLanes),
  );
  for (const variable of [
    'REGRESSION', 'INTEGRATION', 'POSTGRES_INTEGRATION', 'BROWSER_E2E',
    'BROWSER_SYNTAX', 'EDGE_FUNCTIONS', 'WIRING', 'DEPENDENCY_AUDIT',
  ]) {
    assert.ok(aggregate.includes('test "$' + variable + '" = success'), variable + ' must be required to pass');
  }
});
