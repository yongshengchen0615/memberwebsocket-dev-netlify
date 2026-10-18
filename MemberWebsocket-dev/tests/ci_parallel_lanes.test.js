const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test-memberwebsocket-dev.yml'), 'utf8');

test('MemberWebsocket CI cancels stale runs on the same ref', () => {
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /github\.head_ref \|\| github\.ref/);
});

test('MemberWebsocket CI separates expensive test lanes and preserves aggregate validation', () => {
  for (const lane of ['regression:', 'integration:', 'browser-syntax:', 'edge-functions:', 'wiring:', 'dependency-audit:', 'validate:']) {
    assert.ok(workflow.includes('\n  ' + lane), lane + ' lane must exist');
  }
  assert.match(workflow, /needs: \[regression, integration, browser-e2e, browser-syntax, edge-functions, wiring, dependency-audit\]/);
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
