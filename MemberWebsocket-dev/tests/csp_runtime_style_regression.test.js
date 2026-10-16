const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const cspMeta = (relative) => read(relative).split('\n').find((line) => line.includes('Content-Security-Policy')) || '';

test('booking calendar and cancellation sync do not inject runtime style elements', () => {
  const calendar = read('booking/calendar-flow.js');
  const cancellation = read('admin/booking-cancellation-sync.js');
  assert.doesNotMatch(calendar, /createElement\(['"]style['"]\)/);
  assert.doesNotMatch(cancellation, /createElement\(['"]style['"]\)/);
  assert.doesNotMatch(cancellation, /textarea\.style\./);
  assert.match(read('booking/calendar-flow.css'), /CSP-safe holiday styles/);
  assert.match(read('admin/booking-panel.css'), /CSP-safe cancellation review styles/);
});

test('admin CSP allows Leaflet and sanitized runtime style attributes without allowing inline style elements', () => {
  const meta = cspMeta('admin/index.html');
  assert.match(meta, /style-src 'self' https:\/\/cdn\.jsdelivr\.net;/);
  assert.match(meta, /style-src-elem 'self' https:\/\/cdn\.jsdelivr\.net 'sha256-KJIOj901voMKZQZFhhMhuUzk6p4KVITpJJnOB8DP7Gg=';/);
  assert.match(meta, /style-src-attr 'unsafe-inline';/);
  assert.match(meta, /connect-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(meta, /script-src[^;]*'unsafe-inline'/);
});

test('admin accepts only the reported inline style hash while keeping style blocks restricted', () => {
  const meta = cspMeta('admin/index.html');
  const directives = Object.fromEntries(
    meta.match(/content="([^"]+)"/)[1].split(';').map(part => part.trim()).filter(Boolean)
      .map(part => [part.split(/\s+/)[0], part])
  );
  const styleElements = directives['style-src-elem'];
  assert.ok(styleElements);
  assert.match(styleElements, /'self'/);
  assert.match(styleElements, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(styleElements, /'sha256-KJIOj901voMKZQZFhhMhuUzk6p4KVITpJJnOB8DP7Gg='/);
  assert.doesNotMatch(styleElements, /'unsafe-inline'/);
  assert.doesNotMatch(directives['style-src'], /'unsafe-inline'/);
  assert.doesNotMatch(directives['script-src'], /'unsafe-inline'/);
  assert.equal((styleElements.match(/'sha256-/g) || []).length, 1, 'allowlist only the reported block');
});

test('booking CSP permits only style attributes needed for runtime holiday accents', () => {
  const meta = cspMeta('booking/index.html');
  assert.match(meta, /style-src 'self';/);
  assert.match(meta, /style-src-elem 'self';/);
  assert.match(meta, /style-src-attr 'unsafe-inline';/);
  assert.doesNotMatch(meta, /script-src[^;]*'unsafe-inline'/);
});
