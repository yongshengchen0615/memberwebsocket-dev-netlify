const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('user E2E captures bounded diagnostics only for failed cases', () => {
  const runner = read('user-test-control.js');
  assert.match(runner, /function startDiagnosticTrace\(/);
  assert.match(runner, /function buildFailureTrace\(/);
  assert.match(runner, /function resourceTimingsSince\(/);
  assert.match(runner, /\['fetch', 'xmlhttprequest'\]/);
  assert.match(runner, /parsed\.pathname/);
  assert.match(runner, /running\.status === 'failed'/);
  assert.match(runner, /trace: item\.status === 'failed'/);
  assert.match(runner, /function compactFailureTrace\(/);
  assert.match(runner, /compactRecordPayload\?\.\(payload, 60_000\)/);
  assert.match(runner, /events: state\.traceEvents\.slice/);
  assert.match(runner, /booking:bookings-rendered/);
});

test('admin E2E keeps failure diagnostics separate from ordinary successful results', () => {
  const runner = read('admin/e2e-control.js');
  assert.match(runner, /function buildAdminFailureTrace\(/);
  assert.match(runner, /function adminResourceTimingsSince\(/);
  assert.match(runner, /row\.status === 'failed'/);
  assert.match(runner, /trace: item\.status === 'failed'/);
  assert.match(runner, /dataBox\('Diagnostics', item\.trace\)/);
  assert.match(runner, /childFailures/);
  assert.match(runner, /compactRecordPayload\?\.\(payload\)/);
});

test('both browser-run APIs persist a second failure-trace step only for failures', () => {
  const adminApi = read('supabase/functions/test-control-api/index.ts');
  const userApi = read('supabase/functions/user-test-api/index.ts');
  for (const source of [adminApi, userApi]) {
    assert.match(source, /step_key: "failure-trace"/);
    assert.match(source, /name: "失敗診斷 Artifact"/);
    assert.match(source, /diagnosticsCaptured: true/);
    assert.match(source, /failureArtifactCases/);
    assert.match(source, /item\.status === "failed"/);
  }
  assert.match(userApi, /function safeDiagnosticSnapshot\(/);
  assert.match(userApi, /Bearer \[redacted\]/);
  assert.match(userApi, /\[redacted-jwt\]/);
});

test('failure-trace assets are cache-busted on admin and every member surface', () => {
  assert.match(read('admin/index.html'), /e2e-control\.js\?v=qa-e2e-\d{8}-\d+/);
  for (const surface of ['member', 'points', 'event', 'calendar', 'booking']) {
    assert.match(read(surface + '/index.html'), /user-test-control\.js\?v=qa-e2e-\d{8}-\d+/);
  }
});
