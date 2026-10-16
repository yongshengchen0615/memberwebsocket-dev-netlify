const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'admin', 'styles.css'), 'utf8');

test('member 360 uses a single stable scroll container', () => {
  const correction = css.slice(css.indexOf('Member 360 layout correction 2026-09-25'));
  assert.match(correction, /\.member-records-modal-card\s*\{[\s\S]*display:\s*block;[\s\S]*overflow:\s*auto;/);
  assert.match(correction, /\.member-records-list\s*\{[\s\S]*overflow:\s*visible;/);
  assert.match(correction, /\.member-records-list::before,[\s\S]*\.member-record-item::before\s*\{[\s\S]*display:\s*none;/);
});

test('member 360 desktop hierarchy keeps hero actions and metrics predictable', () => {
  const correction = css.slice(css.indexOf('Member 360 layout correction 2026-09-25'));
  assert.match(correction, /grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(correction, /\.member-records-overview-metrics\s*\{[\s\S]*grid-column:\s*1 \/ -1;[\s\S]*repeat\(4/);
  assert.match(correction, /\.member-records-summary\s*\{[\s\S]*repeat\(3/);
});

test('member 360 mobile overrides global bottom-sheet geometry', () => {
  const correction = css.slice(css.indexOf('Member 360 layout correction 2026-09-25'));
  assert.match(correction, /@media \(max-width: 760px\)[\s\S]*#memberRecordsModal[\s\S]*align-items:\s*center/);
  assert.match(correction, /@media \(max-width: 480px\)[\s\S]*#memberRecordsModal[\s\S]*align-items:\s*stretch/);
  assert.match(correction, /min-height:\s*100dvh/);
  assert.match(correction, /border-radius:\s*0/);
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css\?v=[^"]+">/);
});
