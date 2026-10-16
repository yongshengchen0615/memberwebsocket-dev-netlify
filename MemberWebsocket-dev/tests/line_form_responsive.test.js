const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const responsiveCss = fs.readFileSync(path.join(root, 'responsive.css'), 'utf8');

const appPages = [
  'index.html',
  'admin/index.html',
  'member/index.html',
  'points/index.html',
  'event/index.html',
  'calendar/index.html',
  'booking/index.html',
  'booking/admin/index.html',
];

test('every application surface opts into LIFF viewport safety and shared responsive CSS', () => {
  for (const relativePath of appPages) {
    const html = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.match(html, /<meta\s+name="viewport"\s+content="[^"]*width=device-width[^"]*viewport-fit=cover[^"]*">/i, relativePath);
    assert.match(html, /<link\s+rel="stylesheet"\s+href="[^"]*responsive\.css(?:\?[^\"]*)?"/i, relativePath);
  }
});

test('shared CSS prevents intrinsic form-control width from escaping narrow LINE WebViews', () => {
  assert.match(responsiveCss, /form,\s*\nfieldset,\s*\nlabel\s*\{[\s\S]*?min-inline-size:\s*0;/);
  assert.match(responsiveCss, /fieldset\s*\{[\s\S]*?inline-size:\s*100%;[\s\S]*?width:\s*100%;/);
  assert.match(responsiveCss, /legend\s*\{[\s\S]*?max-inline-size:\s*100%;[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(responsiveCss, /input:not\(\[type="checkbox"\]\)[\s\S]*?select,\s*\ntextarea\s*\{[\s\S]*?inline-size:\s*100%;[\s\S]*?min-inline-size:\s*0;/);
  assert.match(responsiveCss, /select\s*\{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
});

test('touch devices keep editable controls at an iOS-safe font size even in landscape', () => {
  assert.match(
    responsiveCss,
    /@media\s*\(pointer:\s*coarse\)[\s\S]*?input:not\(\[type="checkbox"\]\)[\s\S]*?font-size:\s*max\(16px,\s*1em\)\s*!important;/,
  );
});

test('native WebKit date and time inputs remain shrinkable', () => {
  for (const type of ['time', 'date', 'datetime-local', 'month', 'week']) {
    assert.match(responsiveCss, new RegExp(`input\\[type="${type}"\\]`));
  }
  assert.match(responsiveCss, /min-inline-size:\s*0\s*!important;/);
  assert.match(responsiveCss, /::-webkit-date-and-time-value/);
  assert.match(responsiveCss, /-webkit-fill-available/);
});
