const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('background admin runner inherits the already-verified admin session in memory', () => {
  const app = read('admin/app.js');
  const runner = read('admin/e2e-control.js');

  assert.match(app, /function backgroundE2ERunId\(/);
  assert.match(app, /async function waitForBackgroundAdminSession\(/);
  assert.match(app, /window\.opener\.MemberAdminE2EControl\?\.provideBackgroundSession/);
  assert.match(app, /state\.idToken = backgroundSession\.idToken/);
  assert.match(app, /state\.config = backgroundSession\.config/);

  assert.match(runner, /state\.backgroundRunId = runId;[\s\S]*openBackgroundRunnerWindow\(runId\)/);
  assert.match(runner, /function provideBackgroundSession\(requestedRunId\)/);
  assert.match(runner, /runId !== String\(state\.backgroundRunId/);
  assert.match(runner, /window\.MemberAdminSession\?\.get\?\.\(\)/);
  assert.match(runner, /provideBackgroundSession: \(runId\) => provideBackgroundSession\(runId\)/);
  assert.match(runner, /async function waitForBackgroundRunnerControl\(/);
  assert.match(runner, /E2E_BACKGROUND_RUNNER_BOOT_FAILED/);
});

test('background admin runner does not place the admin token in URL or persistent browser storage', () => {
  const app = read('admin/app.js');
  const runner = read('admin/e2e-control.js');

  assert.doesNotMatch(runner, /searchParams\.set\([^\n]*idToken/i);
  assert.doesNotMatch(runner, /localStorage\.setItem\([^\n]*idToken/i);
  assert.doesNotMatch(runner, /sessionStorage\.setItem\([^\n]*idToken/i);
  assert.doesNotMatch(app, /localStorage\.setItem\([^\n]*idToken/i);
  assert.doesNotMatch(app, /sessionStorage\.setItem\([^\n]*idToken/i);
});

test('background runner asset versions force the session-handoff fix to load', () => {
  const html = read('admin/index.html');
  assert.match(html, /app\.js\?v=[^"'\\s>]+/);
  assert.match(html, /e2e-control\.js\?v=[^"'\\s>]+/);
});
