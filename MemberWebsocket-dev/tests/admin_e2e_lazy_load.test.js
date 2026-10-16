const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('admin browser E2E controller is lazy-loaded outside normal startup', () => {
  const html = read('admin/index.html');
  const loader = read('admin/e2e-control-loader.js');
  const controller = read('admin/e2e-control.js');

  assert.match(html, /e2e-control-loader\.js\?v=[^"'\s]+/);
  assert.doesNotMatch(html, /<script src="\.\/e2e-control\.js\?/);

  assert.match(loader, /const E2E_CONTROL_SRC = '\.\/e2e-control\.js\?v=[^'\s]+&lazy=[^'\s]+'/);
  const declared = html.match(/data-e2e-control-src="([^"]+)"/)[1];
  const loaded = loader.match(/const E2E_CONTROL_SRC = '([^']+)'/)[1].split('&lazy=')[0];
  assert.equal(loaded, declared, 'the declared and requested controller assets must use the same version');
  assert.match(loader, /getElementById\('testModeTab'\)/);
  assert.match(loader, /addEventListener\('pointerenter'/);
  assert.match(loader, /addEventListener\('focus'/);
  assert.match(loader, /addEventListener\('click'/);
  assert.match(loader, /document\.head\.appendChild\(script\)/);

  assert.match(controller, /if \(document\.readyState === 'loading'\)/);
  assert.match(controller, /window\.addEventListener\('DOMContentLoaded', mount, \{ once: true \}\)/);
  assert.match(controller, /document\.readyState === 'interactive' \|\| document\.readyState === 'complete'/);
});
