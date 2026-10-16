const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('member snapshot details use four counted tabs with exclusive server-defined categories', () => {
  const ui = read('booking/booking-accessible.js');
  const css = read('booking/booking-accessible.css');
  const html = read('booking/index.html');
  for (const key of ['pending', 'registered', 'attention', 'withdrawn']) {
    assert.match(ui, new RegExp("key: '" + key + "'"));
    assert.ok(ui.includes('snapshotHistoryTab-' + "' + group.key"));
    assert.ok(ui.includes('snapshotHistoryPanel-' + "' + group.key"));
  }
  assert.match(ui, /row\.cancelled === true\) return 'withdrawn'/);
  assert.match(ui, /row\.dismissed === true \|\| row\.status === 'failed'\) return 'attention'/);
  assert.match(ui, /row\.status === 'bound'\) return 'registered'/);
  assert.match(ui, /return 'pending'/);
  assert.match(ui, /groups\.get\(snapshotHistoryGroup\(row\)\)\.push\(details\)/);
  assert.match(ui, /items\.length \+ ' 筆'/);
  assert.match(ui, /role', 'tablist'/);
  assert.match(ui, /role', 'tabpanel'/);
  assert.match(ui, /aria-selected/);
  assert.match(ui, /aria-controls/);
  assert.match(ui, /panel\.hidden = !selected/);
  assert.match(ui, /snapshotHistoryTabSelected/);
  assert.match(ui, /ArrowRight/);
  assert.match(ui, /booking-detail-target/);
  assert.match(ui, /details\.open = true/);
  assert.match(ui, /history\.replaceChildren\(\)/);
  assert.match(ui, /history\.hidden = true/);
  assert.match(css, /snapshot-history-panel\[hidden\]/);
  assert.match(html, /booking-accessible\.css\?v=[^"]*history-tabs-20261014-1/);
  assert.match(html, /booking-accessible\.js\?v=[^"]*history-tabs-20261014-1/);
});

test('snapshot classification retains existing approval, ticket and cancellation actions', () => {
  const ui = read('booking/booking-accessible.js');
  const receipt = read('booking/booking-receipt.js');
  const api = read('supabase/functions/booking-receipt-api/index.ts');
  assert.match(ui, /user\.booking\.receipt\.cancel/);
  assert.match(receipt, /user\.booking\.receipt\.list/);
  assert.match(ui, /requestedBenefits/);
  assert.match(ui, /settlement\.service_minutes/);
  assert.match(ui, /snapshotHistoryStatusLabel\(row\)/);
  assert.match(api, /\.eq\("member_id",member\.id\)/);
  assert.match(api, /\.eq\("submission_mode","accessible"\)/);
  execFileSync(process.execPath, ['--check', path.join(root, 'booking/booking-accessible.js')], { stdio: 'pipe' });
});
