const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.resolve(__dirname, '../points/index.html'), 'utf8');

test('AC-001: points client omits the redundant rewards introduction', () => {
  assert.doesNotMatch(html, /集點進度、會員資格與可使用票券。/);
  assert.doesNotMatch(html, /<section class="workspace-intro">/);
});

test('AC-002: points client keeps the working membership, card and ticket views', () => {
  for (const id of ['pointsView', 'membershipProgress', 'cardTabs', 'activeCardView', 'ticketHistoryList']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
});
