const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const core = read('admin/booking-panel-core.js');
const cancellation = read('admin/booking-cancellation-sync.js');
const css = read('admin/booking-panel.css');
const shared = read('experience.css');
const index = read('admin/index.html');

test('standard booking status filters keep accessible-review UI parity', () => {
  const filterStart = core.indexOf('aria-label="一般預約狀態篩選"');
  assert.ok(filterStart >= 0, 'standard booking status filter should exist');

  const pending = core.indexOf('data-booking-filter="pending"', filterStart);
  const confirmed = core.indexOf('data-booking-filter="confirmed"', filterStart);
  const completed = core.indexOf('data-booking-filter="completed"', filterStart);
  const all = core.indexOf('data-booking-filter="all"', filterStart);
  assert.ok(pending < confirmed && confirmed < completed && completed < all, 'core booking filters should retain their order');

  const cancelRequest = cancellation.indexOf("requestButton.textContent = '取消申請'");
  const cancelled = cancellation.indexOf("cancelledButton.textContent = '已取消'");
  assert.ok(cancelRequest >= 0 && cancelled > cancelRequest, 'cancellation filters should exist');
  assert.match(cancellation, /confirmedButton\.insertAdjacentElement\('afterend', requestButton\)/);
  assert.match(cancellation, /requestButton\.insertAdjacentElement\('afterend', cancelledButton\)/);

  assert.match(css, /standard booking status navigation parity with accessible review 20261005/);
  assert.match(css, /#bookingPanel \.booking-admin-queue-toolbar\{[\s\S]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(shared, /booking-admin-filter, \.accessible-admin-history-tabs/);
  assert.match(shared, /background: var\(--theme-surface-muted\)/);
  assert.match(shared, /background: var\(--theme-surface-raised\)/);
  assert.match(shared, /overflow-x: auto/);
  assert.match(shared, /-webkit-overflow-scrolling: touch/);
  assert.match(index, /booking-panel\.css\?v=booking-standard-filter-parity-20261005-1/);
});
