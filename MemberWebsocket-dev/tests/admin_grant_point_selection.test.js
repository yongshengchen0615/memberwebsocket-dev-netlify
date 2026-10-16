const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'admin', 'app.js'), 'utf8');

test('multi-card grant keeps selected cards visible but disables them in other rows', () => {
  assert.match(app, /activeGrantCards\(\)\.forEach\(\(card\) =>/);
  assert.match(app, /function syncGrantPointCardOptions\(\)/);
  assert.match(app, /const selectedElsewhere = selectedIds\.includes\(cardId\) && cardId !== currentId/);
  assert.match(app, /option\.disabled = selectedElsewhere/);
  assert.match(app, /（已選擇）/);
});

test('grant point options resync whenever the editor state changes', () => {
  assert.match(app, /function updateGrantPointHint\(\) \{ syncGrantPointCardOptions\(\);/);
  assert.match(app, /if \(addStamps\) syncGrantPointCardOptions\(\);/);
});

test('duplicate card ids remain rejected before the grant request is sent', () => {
  assert.match(app, /new Set\(points\.map\(\(point\) => point\.cardId\)\)\.size !== points\.length/);
});
