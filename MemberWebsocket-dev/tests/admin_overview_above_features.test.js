const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'admin/app.js'), 'utf8');

test('AC-001: the shared operations overview precedes every admin feature tab and panel', () => {
  const admin = html.slice(html.indexOf('<main id="adminView"'));
  const positions = [
    '<header class="topbar">',
    '<section class="ops-overview" aria-labelledby="opsOverviewTitle">',
    '<section class="stats-row" aria-label="目前概況">',
    '<nav class="surface-nav" role="tablist" aria-label="管理功能">',
    '<section id="membersPanel"',
  ].map((marker) => {
    const index = admin.indexOf(marker);
    assert.notEqual(index, -1, `Missing admin element: ${marker}`);
    return index;
  });
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i - 1] < positions[i], 'Overview and metrics must be above the feature section');
  }
});

test('AC-002: overview remains a single, shared section across admin tabs', () => {
  assert.equal((html.match(/id="opsOverviewTitle"/g) || []).length, 1);
  assert.equal((html.match(/class="stats-row" aria-label="目前概況"/g) || []).length, 1);
  for (const id of ['membersTab', 'cardsTab', 'eventsTab', 'calendarTab']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('AC-003: moving metrics preserves the live data bindings', () => {
  for (const id of [
    'memberCount', 'activeMemberCount', 'activeCardCount',
    'activeEventTicketCount', 'todayEntryCount',
  ]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
    assert.match(app, new RegExp(`els\\.${id}\\.textContent`), id);
  }
});
