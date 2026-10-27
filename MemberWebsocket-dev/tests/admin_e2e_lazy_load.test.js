const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('AC-001/002: admin workspace has no test center, runner, history or test settings entrypoints', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const hub = read('admin/integration-hub.js');
  for (const id of ['testModeTab', 'testModePanel', 'purgeTestDataButton', 'testModeForm', 'automationTestHistoryList']) {
    assert.doesNotMatch(html, new RegExp('id="' + id + '"'));
  }
  for (const asset of [
    'test-mode.js', 'test-control.js', 'e2e-control-loader.js', 'e2e-flow-visualizer.js',
    'test-workspace-tabs.js', 'e2e-feature-coverage.js', 'e2e-scenario-graph.js', 'e2e-professional-tester.js',
    'test-mode.css', 'test-control.css', 'e2e-control.css', 'e2e-flow-visualizer.css', 'test-workspace-tabs.css'
  ]) assert.ok(!html.includes(asset), 'Removed admin test-only asset is still loaded: ' + asset);
  assert.doesNotMatch(app, /testModeTab|testModePanel|switchPanel\('testMode'\)/);
  assert.doesNotMatch(hub, /testModeTab|testModePanel/);
  for (const id of ['membersTab', 'cardsTab', 'eventsTab', 'calendarTab', 'operationsHubPanel']) {
    assert.match(id === 'operationsHubPanel' ? hub : html, new RegExp(id));
  }
});

test('AC-003: test-only fixture preserves the E2E loader and background execution contracts', () => {
  const fixture = read('tests/fixtures/admin-test-center.html');
  const loader = read('admin/e2e-control-loader.js');
  const controller = read('admin/e2e-control.js');
  for (const id of ['testModeTab', 'testModePanel', 'automationTestHistoryList', 'purgeTestDataButton']) {
    assert.match(fixture, new RegExp('id="' + id + '"'));
  }
  assert.match(loader, /const E2E_CONTROL_SRC = '\.\/e2e-control\.js\?v=[^'\s]+&lazy=[^'\s]+'/);
  assert.match(loader, /getElementById\('testModeTab'\)/);
  for (const event of ['pointerenter', 'focus', 'click']) assert.ok(loader.includes(`addEventListener('${event}'`));
  assert.match(loader, /document\.head\.appendChild\(script\)/);
  assert.match(controller, /if \(document\.readyState === 'loading'\)/);
  assert.match(controller, /window\.addEventListener\('DOMContentLoaded', mount, \{ once: true \}\)/);
  assert.match(controller, /document\.readyState === 'interactive' \|\| document\.readyState === 'complete'/);
});
