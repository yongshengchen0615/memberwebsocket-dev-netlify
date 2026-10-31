const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test-memberwebsocket-dev.yml'), 'utf8');

test('MemberWebsocket CI cancels stale runs within the same event and branch or PR', () => {
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /cancel-in-progress: true/);
  // A PR tests a synthetic merge, so it must not cancel its source branch's
  // release baseline. Different PRs may also have different target branches.
  assert.match(workflow, /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
});

test('MemberWebsocket CI separates expensive test lanes and preserves aggregate validation', () => {
  for (const lane of ['regression:', 'integration:', 'browser-syntax:', 'edge-functions:', 'wiring:', 'dependency-audit:', 'validate:']) {
    assert.ok(workflow.includes('\n  ' + lane), lane + ' lane must exist');
  }
  assert.match(workflow, /needs: \[regression, integration, postgres-integration, browser-e2e, browser-syntax, edge-functions, wiring, dependency-audit\]/);
  assert.match(workflow, /POSTGRES_INTEGRATION: \$\{\{ needs\.postgres-integration\.result \}\}/);
  assert.match(workflow, /test "\$POSTGRES_INTEGRATION" = success/);
  assert.match(workflow, /test "\$BROWSER_E2E" = success/);
  assert.match(workflow, /test "\$REGRESSION" = success/);
  assert.match(workflow, /test "\$EDGE_FUNCTIONS" = success/);
  assert.match(workflow, /test "\$DEPENDENCY_AUDIT" = success/);
  assert.match(workflow, /npm audit --prefix MemberWebsocket-dev\/tests\/browser --audit-level=low/);
  assert.match(workflow, /npm audit --prefix MemberWebsocket-dev\/tests\/integration --audit-level=low/);
});

test('main CI executes Edge unit tests and receipt refresh race regressions', () => {
  assert.match(workflow, /deno test \\\n\s+MemberWebsocket-dev\/supabase\/functions\/_shared\/\*_test\.ts/);
  assert.match(workflow, /MemberWebsocket-dev\/supabase\/functions\/booking-line-notifications\/delivery_test\.ts/);
  assert.match(workflow, /MemberWebsocket-dev\/tests\/integration\/receipt_refresh_state\.cjs/);
});

test('browser baseline is sharded without filtering cases or increasing its time budget', () => {
  const browser = workflow.split('\n  browser-e2e:')[1].split('\n  browser-syntax:')[0];
  assert.match(browser, /timeout-minutes: 15\n/);
  assert.match(browser, /fail-fast: false\n/);
  assert.match(browser, /shard: \[1, 2, 3\]/);
  const commands = [...browser.matchAll(/^        run: (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(commands.filter(command => command.startsWith('npm test')), [
    'npm test -- --shard=${{ matrix.shard }}/3',
  ], 'Each shard must run the complete unfiltered suite exactly once');
  assert.doesNotMatch(browser, /continue-on-error|--grep|--retries|--max-failures/);
});

test('each browser shard retains separate diagnostics and all shards gate validation', () => {
  const browser = workflow.split('\n  browser-e2e:')[1].split('\n  browser-syntax:')[0];
  assert.match(browser, /if: always\(\)/);
  assert.match(browser, /name: memberwebsocket-browser-\$\{\{ matrix\.shard \}\}-\$\{\{ github\.run_attempt \}\}/);
  const validate = workflow.split('\n  validate:')[1];
  assert.match(validate, /if: always\(\)/);
  assert.match(validate, /needs: \[[^\n]*browser-e2e/);
  assert.match(validate, /BROWSER_E2E: \$\{\{ needs\.browser-e2e\.result \}\}/);
  assert.match(validate, /test "\$BROWSER_E2E" = success/);
});
