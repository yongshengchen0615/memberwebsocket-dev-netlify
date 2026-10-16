const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../admin/calendar-responsive.css'), 'utf8');

test('mobile admin calendar has a final viewport-fit override', () => {
  const marker = 'LINE mobile calendar: keep all seven date columns inside the viewport.';
  const markerIndex = css.lastIndexOf(marker);
  assert.ok(markerIndex >= 0, 'missing LINE mobile calendar viewport-fit override');

  const mobileFit = css.slice(markerIndex);
  assert.match(mobileFit, /@media\s*\(max-width:\s*760px\)/);
  assert.match(mobileFit, /\.admin-calendar-weekdays,[\s\S]*?\.admin-calendar-grid\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(mobileFit, /\.admin-calendar\s*\{[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(mobileFit, /\.admin-calendar-day-header\s*\{[\s\S]*?grid-template-columns:\s*16px\s+minmax\(0,\s*1fr\)/);
  assert.match(mobileFit, /\.admin-calendar-selection\s*\{[\s\S]*?inline-size:\s*16px;[\s\S]*?max-width:\s*16px;/);
});

test('very narrow phones reduce calendar selection controls further', () => {
  const markerIndex = css.lastIndexOf('LINE mobile calendar: keep all seven date columns inside the viewport.');
  const mobileFit = css.slice(markerIndex);
  assert.match(mobileFit, /@media\s*\(max-width:\s*420px\)[\s\S]*?\.admin-calendar-selection\s*\{[\s\S]*?inline-size:\s*14px;[\s\S]*?max-width:\s*14px;/);
});
