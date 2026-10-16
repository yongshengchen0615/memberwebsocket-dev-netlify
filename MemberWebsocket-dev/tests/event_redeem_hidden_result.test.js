const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'event/app.js'), 'utf8');

test('successful event redemption renders the durable result before non-critical list rerender', () => {
  const body = app.match(/async function redeemTicket\(offer\) \{([\s\S]*?)\n  \}\n\n  function currentRedemptionLocation/)?.[1] || '';
  const resultIndex = body.indexOf('await showRedeemedResult(result.ticket);');
  const renderIndex = body.indexOf('renderOffers();', resultIndex);
  assert.ok(resultIndex >= 0, 'redeem flow must render the server-confirmed result');
  assert.ok(renderIndex > resultIndex, 'list rerender must not block the success result');
});

test('lottery reveal animation never delays persisted result while the page is hidden', () => {
  const body = app.match(/async function showRedeemedResult\(claim\) \{([\s\S]*?)\n  \}\n\n  function renderRedeemedResult/)?.[1] || '';
  assert.match(body, /claim\.ticketType === 'lottery' && claim\.result && document\.visibilityState === 'visible'/);
  assert.match(body, /renderRedeemedResult\(claim\)/);
});
