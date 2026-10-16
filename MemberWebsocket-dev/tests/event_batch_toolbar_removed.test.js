const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('event page does not load or render the removed batch redemption toolbar', () => {
  const html = read('event/index.html');
  const app = read('event/app.js');

  assert.doesNotMatch(html, /batch-redemption\.(?:css|js)/);
  assert.doesNotMatch(html, /event-batch-toolbar/);
  assert.match(app, /button\.textContent = history \? '查看紀錄'[\s\S]*offer\.claim \? offer\.canUse \? '查看並使用'/);
  assert.match(app, /async function redeemTicket\(offer\)/);
  assert.match(app, /user\.event\.ticket\.redeem/);
});
