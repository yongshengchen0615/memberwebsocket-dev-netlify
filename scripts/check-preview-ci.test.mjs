import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreviewCI } from './check-preview-ci.mjs';

const sha = 'a'.repeat(40);
const baseline = ['test-memberwebsocket-dev.yml', 'test-netlify-build.yml', 'test-memberwebsocket-ticket-policy.yml']
  .map((file, index) => ({ id: index + 1, path: `.github/workflows/${file}`, head_sha: sha, status: 'completed', conclusion: 'success' }));

test('all three latest workflows on the exact commit must succeed', () => {
  assert.equal(evaluatePreviewCI(baseline, sha).status, 'success');
  assert.equal(evaluatePreviewCI(baseline, 'b'.repeat(40)).status, 'pending');
  assert.equal(evaluatePreviewCI(baseline.slice(1), sha).status, 'pending');
});
test('an older successful run cannot hide a newer failure, cancellation, skip or timeout', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required']) {
    assert.equal(evaluatePreviewCI([...baseline, { ...baseline[0], id: 10, conclusion }], sha).status, 'failure', conclusion);
  }
});
test('an older success cannot hide a pending rerun on the same SHA', () => {
  const result = evaluatePreviewCI([...baseline, { ...baseline[0], id: 10, status: 'in_progress', conclusion: null }], sha);
  assert.equal(result.status, 'pending');
  assert.equal(result.workflows[0].runId, 10);
});
test('successful replacement supersedes older cancelled duplicate without counting other SHAs', () => {
  const older = { ...baseline[0], id: 0, conclusion: 'cancelled' };
  const differentCommit = { ...baseline[0], id: 100, head_sha: 'b'.repeat(40), conclusion: 'failure' };
  assert.equal(evaluatePreviewCI([...baseline, older, differentCommit], sha).status, 'success');
});
test('a familiar display name on a different workflow cannot satisfy the gate', () => {
  const runs = baseline.map(run => ({ ...run, path: '.github/workflows/unrelated.yml', name: 'Test MemberWebsocket Dev' }));
  assert.equal(evaluatePreviewCI(runs, sha).status, 'pending');
});
