'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('./helpers/edge-test-fs.cjs');

const root = path.resolve(__dirname, '..');
const read = (filename) => fs.readFileSync(path.join(root, filename), 'utf8');
const retiredAssets = /(?:test-mode-client\.js|test-mode\.css|user-test-control\.css|user-test-control\.js|e2e-feature-coverage\.js|e2e-scenario-graph\.js|e2e-professional-tester\.js)/;

for (const surface of ['member', 'points', 'event', 'calendar', 'booking']) {
  test(`AC-001: ${surface} production page does not ship test-session or in-page QA assets`, () => {
    const html = read(`${surface}/index.html`);
    assert.doesNotMatch(html, retiredAssets);
    assert.match(html, /\.\.\/member-system\.js/);
  });
}

test('AC-002: production member sign-in uses verified LINE credentials rather than test sessions', () => {
  const code = read('member-system.js');
  assert.doesNotMatch(code, /TestModeClient/);
  assert.match(code, /const idToken = await lineSignIn\(config, surface\)/);
  assert.match(code, /if \(idToken && surface !== 'admin'\)/);
  assert.match(code, /claimBrowserSession\(config, surface, idToken\)/);
});

test('AC-003: admin directory and history cannot select virtual members or QA actions', () => {
  const html = read('admin/index.html');
  const code = read('admin/app.js');
  assert.doesNotMatch(html, /testMembersSubtab|memberUsageKind|data-record-filter="testAutomation"|memberTestProfileFields|grantTestNotificationNote/);
  assert.doesNotMatch(code, /testMembersSubtab|memberUsageKind|memberIsTestAccount|memberTestProfileFields|grantTestNotificationNote/);
  assert.match(html, /id="memberTableBody"/);
  assert.match(html, /id="memberUsageSelect"/);
  assert.match(code, /memberKind: 'real'/);
  assert.match(code, /admin\.members\.list/);
});
