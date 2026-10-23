import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../MemberWebsocket-dev/admin/index.html', import.meta.url), 'utf8');

test('AC-LNN-001: the account menu does not duplicate business LINE settings navigation', () => {
  assert.doesNotMatch(
    html,
    /<a\b[^>]*href=["']#productizedAdmin["'][^>]*>\s*商家\s*LINE\s*設定\s*<\/a>/u,
    'Remove the obsolete business LINE settings shortcut; retain the approved settings tab',
  );
});

test('AC-LNN-001: retain exactly one grant-controlled LINE settings tab and panel', () => {
  assert.equal((html.match(/id="lineSettingsTab"/g) || []).length, 1);
  assert.equal((html.match(/id="lineSettingsPanel"/g) || []).length, 1);
  assert.match(html, /id="lineSettingsTab"[^>]*aria-controls="lineSettingsPanel"[^>]*data-business-allowed="false"[^>]*hidden disabled/);
  assert.match(html, /id="lineSettingsPanel"[^>]*aria-labelledby="lineSettingsTab"[^>]*hidden/);
});
