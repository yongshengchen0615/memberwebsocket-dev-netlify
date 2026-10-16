const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('shared theme exposes Material 3 color, shape, elevation and motion tokens', () => {
  const css = read('theme.css');
  assert.match(css, /Material 3 convergence layer 2026-09-29/);
  for (const token of [
    '--md-sys-color-primary',
    '--md-sys-color-primary-container',
    '--md-sys-color-secondary-container',
    '--md-sys-color-surface-container-low',
    '--md-sys-color-surface-container-high',
    '--md-sys-color-on-surface',
    '--md-sys-color-outline',
    '--md-sys-shape-corner-extra-large',
    '--md-sys-elevation-level3',
    '--md-sys-motion-easing-standard'
  ]) {
    assert.ok(css.includes(token), token + ' should be defined');
  }
});

test('M3 compatibility layer preserves existing app selectors', () => {
  const css = read('theme.css');
  assert.match(css, /--ui-primary:\s*var\(--md-sys-color-primary\)/);
  assert.match(css, /\.surface-tab\[aria-selected="true"\][\s\S]*?var\(--md-sys-color-primary-container\)/);
  assert.match(css, /\.modal-card,[\s\S]*?\.booking-selection-modal-card[\s\S]*?var\(--md-sys-shape-corner-extra-large\)/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?min-height:\s*48px/);
  assert.doesNotMatch(css, /backdrop-filter:\s*blur\(/);
  assert.doesNotMatch(css, /color-mix\(/);
});

test('all primary surfaces opt into the Material 3 shared layer with cache busting', () => {
  for (const entry of ['admin', 'member', 'points', 'event', 'calendar', 'booking']) {
    const html = read(path.join(entry, 'index.html'));
    assert.match(html, /data-ui-system="material-3"/, entry);
    assert.match(html, /\.\.\/theme\.css\?v=m3-ui-20261001-booking-topbar-parity-3/, entry);
    assert.match(html, /\.\.\/theme\.js\?v=m3-ui-20260929-1/, entry);
  }

  const rootHtml = read('index.html');
  assert.match(rootHtml, /data-ui-system="material-3"/);
  assert.match(rootHtml, /theme\.css\?v=m3-ui-20261001-booking-topbar-parity-3/);
  assert.match(rootHtml, /theme\.js\?v=m3-ui-20260929-1/);
});
