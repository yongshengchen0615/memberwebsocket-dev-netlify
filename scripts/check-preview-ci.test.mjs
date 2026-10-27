import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { evaluatePreviewCI } from './check-preview-ci.mjs';

const sha = 'a'.repeat(40);
const branch = 'Integrated-Marketing-Platform';
const baseline = ['test-memberwebsocket-dev.yml', 'test-netlify-build.yml', 'test-memberwebsocket-ticket-policy.yml']
  .map((file, index) => ({ id: index + 1, path: `.github/workflows/${file}`, head_sha: sha, head_branch: branch, event: 'push', status: 'completed', conclusion: 'success' }));

test('missing source branch fails closed', () => {
  for (const invalid of [undefined, null, '', ' ']) {
    assert.throws(() => evaluatePreviewCI(baseline, sha, invalid), /Expected preview source branch/);
  }
});

test('PR merge tests cannot replace cancelled exact-branch push tests', () => {
  const cancelled = { ...baseline[0], conclusion: 'cancelled' };
  const pr = { ...baseline[0], id: 10, event: 'pull_request' };
  const result = evaluatePreviewCI([cancelled, ...baseline.slice(1), pr], sha, branch);
  assert.equal(result.status, 'failure');
  assert.equal(result.workflows[0].runId, cancelled.id);
});

test('only pushes from the expected branch can establish release evidence', () => {
  for (const event of ['pull_request', 'pull_request_target', 'workflow_dispatch', undefined]) {
    assert.equal(evaluatePreviewCI(baseline.map(run => ({ ...run, event })), sha, branch).status, 'pending', String(event));
  }
  for (const head_branch of ['develop', 'feature/unrelated', undefined]) {
    assert.equal(evaluatePreviewCI(baseline.map(run => ({ ...run, head_branch })), sha, branch).status, 'pending', String(head_branch));
  }
});

test('newer unrelated PR results cannot hide or block valid push evidence', () => {
  for (const conclusion of ['success', 'failure', 'cancelled', null]) {
    const pr = { ...baseline[0], id: 10, event: 'pull_request', conclusion, status: conclusion ? 'completed' : 'in_progress' };
    assert.equal(evaluatePreviewCI([...baseline, pr], sha, branch).status, 'success');
  }
});

test('all three latest workflows on the exact commit must succeed', () => {
  assert.equal(evaluatePreviewCI(baseline, sha, branch).status, 'success');
  assert.equal(evaluatePreviewCI(baseline, 'b'.repeat(40), branch).status, 'pending');
  assert.equal(evaluatePreviewCI(baseline.slice(1), sha, branch).status, 'pending');
});
test('an older successful run cannot hide a newer failure, cancellation, skip or timeout', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required']) {
    assert.equal(evaluatePreviewCI([...baseline, { ...baseline[0], id: 10, conclusion }], sha, branch).status, 'failure', conclusion);
  }
});
test('an older success cannot hide a pending rerun on the same SHA', () => {
  const result = evaluatePreviewCI([...baseline, { ...baseline[0], id: 10, status: 'in_progress', conclusion: null }], sha, branch);
  assert.equal(result.status, 'pending');
  assert.equal(result.workflows[0].runId, 10);
});
test('successful replacement supersedes older cancelled duplicate without counting other SHAs', () => {
  const older = { ...baseline[0], id: 0, conclusion: 'cancelled' };
  const differentCommit = { ...baseline[0], id: 100, head_sha: 'b'.repeat(40), conclusion: 'failure' };
  assert.equal(evaluatePreviewCI([...baseline, older, differentCommit], sha, branch).status, 'success');
});
test('a familiar display name on a different workflow cannot satisfy the gate', () => {
  const runs = baseline.map(run => ({ ...run, path: '.github/workflows/unrelated.yml', name: 'Test MemberWebsocket Dev' }));
  assert.equal(evaluatePreviewCI(runs, sha, branch).status, 'pending');
});


function previewWorkflowEventPaths(filename, event) {
  const yaml = readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8');
  const patterns = [];
  let inEvent = false;
  let inPaths = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (line === `  ${event}:`) { inEvent = true; inPaths = false; continue; }
    if (!inEvent) continue;
    if (/^  [\w-]+:/.test(line)) break;
    if (/^    paths:\s*$/.test(line)) { inPaths = true; continue; }
    const pathMatch = inPaths && line.match(/^      - ['"]([^'"]+)['"]\s*$/);
    if (pathMatch) { patterns.push(pathMatch[1]); continue; }
    if (inPaths && line.trim() && !line.startsWith('      ')) inPaths = false;
  }
  return patterns;
}

test('Preview publishing change paths always trigger exact-SHA Ticket Policy push and PR CI', () => {
  const publishedPaths = previewWorkflowEventPaths('publish-platform-preview.yml', 'push');
  assert.ok(publishedPaths.length > 0, 'Preview publisher must declare push paths');
  for (const event of ['push', 'pull_request']) {
    const policyPaths = previewWorkflowEventPaths('test-memberwebsocket-ticket-policy.yml', event);
    assert.ok(policyPaths.length > 0, `Ticket Policy ${event} paths must be explicit`);
    for (const publishPath of publishedPaths) {
      assert.ok(policyPaths.some(policyPath => policyPath === publishPath
        || (policyPath.endsWith('/**') && publishPath.startsWith(policyPath.slice(0, -2)))),
      `Ticket Policy ${event} must cover publishing path ${publishPath} to prevent an unresolvable exact-SHA gate`);
    }
  }
});
