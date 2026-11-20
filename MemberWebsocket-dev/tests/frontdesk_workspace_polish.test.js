const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('AC-FD-UX-001: workspace retains the original stylesheet and loads mobile enhancements', () => {
  const html = read('frontdesk/index.html');
  assert.match(html, /styles\.css\?v=20261120-ux1/);
  assert.match(html, /workspace-polish\.css\?v=20261120-ux2/);
  assert.match(html, /id="bookings"/);
  assert.match(html, /aria-controls="bookings"/);
  assert.match(html, /預約工作清單/);
});

test('AC-FD-UX-002: mobile layout stacks contact data and retains safe-area spacing', () => {
  const css = read('frontdesk/workspace-polish.css');
  assert.match(css, /@media\(max-width:650px\)/);
  assert.match(css, /frontdesk-card-details\{grid-template-columns:1fr/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.ok(css.includes('.frontdesk-page .frontdesk-actions button{width:100%;flex:auto}'), 'mobile button sizing must override desktop flex basis');
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('AC-FD-UX-003: styling remains scoped to standalone staff view without changing authorization', () => {
  const css = read('frontdesk/workspace-polish.css');
  assert.doesNotMatch(css, /frontdesk-settings/);
  for (const rule of css.match(/(?:^|\n)\s*([^{}]+)\{/g) || []) {
    if (/^\s*@/.test(rule)) continue;
    assert.match(rule, /\.frontdesk-page/);
  }
  const app = read('frontdesk/app.js');
  assert.match(app, /frontdesk\.booking\.update/);
  assert.match(app, /permissionMode==='review'/);
  assert.match(app, /frontdesk\.bootstrap/);
});
