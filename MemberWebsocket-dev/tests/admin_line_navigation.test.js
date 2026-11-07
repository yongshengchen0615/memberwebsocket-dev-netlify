const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');

const html = readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');

test('AC-LNN-001: the account menu has no duplicate business LINE settings link', () => {
  assert.doesNotMatch(
    html,
    /<a\b[^>]*href=["']#productizedAdmin["'][^>]*>\s*商家\s*LINE\s*設定\s*<\/a>/u,
    'Remove obsolete header shortcut while retaining the authorized settings tab',
  );
});

test('AC-LNN-001: canonical LINE settings tab and panel are present exactly once', () => {
  assert.equal((html.match(/id="lineSettingsTab"/g) || []).length, 1);
  assert.equal((html.match(/id="lineSettingsPanel"/g) || []).length, 1);
  assert.match(html, /id="lineSettingsTab"[^>]*aria-controls="lineSettingsPanel"[^>]*data-business-allowed="false"[^>]*hidden disabled/);
  assert.match(html, /id="lineSettingsPanel"[^>]*aria-labelledby="lineSettingsTab"[^>]*hidden/);
});
