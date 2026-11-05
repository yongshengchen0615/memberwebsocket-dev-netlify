const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('AC-001: My Merchants loads the shared light/dark preference and accessible toggle', () => {
  const html = read('admin/workspace.html');
  assert.match(html, /<html[^>]*data-workspace="merchant"[^>]*data-portal-surface="admin"/);
  assert.match(html, /<meta name="theme-color" content="#f9fbf9">/);
  assert.match(html, /<link rel="stylesheet" href="\.\.\/theme\.css\?v=[^"]+">/);
  assert.match(html, /<script src="\.\.\/theme\.js\?v=m3-ui-20260929-1"><\/script>/);
  assert.match(html, /<div class="platform-appearance account-menu" role="group" aria-label="外觀設定"><\/div>/);
  assert.match(read('theme.js'), /const STORAGE_KEY = 'lumen-color-theme-v1'/);
});

test('AC-002: merchant surface uses semantic platform colors in both modes', () => {
  const css = read('platform/platform.css');
  assert.match(css, /html\[data-portal-surface="platform"\],\s*html\[data-workspace="merchant"\]\s*\{/);
  assert.match(css, /--platform-text:var\(--theme-text\)/);
  assert.match(css, /--platform-bg:var\(--theme-bg\)/);
  assert.match(css, /--platform-surface-raised:var\(--theme-surface-raised\)/);
  assert.match(css, /--platform-on-primary:var\(--ui-primary-contrast\)/);
  assert.match(css, /html\[data-workspace="merchant"\][^\n]*:focus-visible/);
  assert.match(css, /\.platform-appearance\.account-menu/);
});

test('AC-003: all merchant settings keep token-driven dark-compatible surfaces', () => {
  const css = read('platform/platform.css');
  const line = read('admin/business-line-settings.css');
  assert.match(css, /#myMerchantList \[data-manage-merchant\]/);
  assert.match(css, /#merchantLineForm>\[data-merchant-panel\]\{background:var\(--platform-surface-raised/);
  assert.match(css, /\.tenant-card\{[^\n]*background:var\(--platform-surface-raised/);
  assert.match(css, /input\{[^\n]*background:var\(--platform-surface-raised/);
  assert.match(line, /\.business-line-settings\{[^\n]*background:var\(--theme-surface-raised\)/);
});
