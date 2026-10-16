const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('my bookings has four mutually exclusive status tabs with live counts', () => {
  const ui = read('booking/member-ui.js');
  const page = read('booking/index.html');
  const css = read('booking/booking-history.css');

  for (const key of ['reserved', 'completed', 'cancelled', 'no_show']) {
    assert.match(ui, new RegExp("key: '" + key + "'"));
    assert.ok(ui.includes('bookingHistoryTab-') && ui.includes('bookingHistoryPanel-'));
  }
  assert.match(ui, /status-no_show/);
  assert.match(ui, /status-cancelled.*status-rejected/);
  assert.match(ui, /grouped\.get\(group\.key\)\.length/);
  assert.match(ui, /badge\.textContent =/);
  assert.match(ui, /role', 'tablist'/);
  assert.match(ui, /role', 'tabpanel'/);
  assert.match(ui, /aria-selected/);
  assert.match(ui, /aria-controls/);
  assert.match(ui, /panel\.hidden = !selected/);
  assert.match(ui, /bookingGroupManuallySelected/);
  assert.match(ui, /booking-history-tabs'\)\)\) \{/);
  assert.match(ui, /booking-detail-target/);
  assert.match(ui, /handleBookingTabKeydown/);
  assert.match(css, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /booking-service-group\[role="tabpanel"\]\[hidden\]/);
  assert.match(page, /booking-history-status-tabs-20261014-1/);
  assert.match(page, /依狀態切換預約紀錄/);
});

test('tab refactor keeps booking cancellation and card accordion interfaces intact', () => {
  const app = read('booking/app.js');
  const ui = read('booking/member-ui.js');
  assert.match(app, /BookingMemberUI\?\.organizeBookingHistory\?\.\(\)/);
  assert.match(app, /cancelBooking\(booking, cancelButton\)/);
  assert.match(app, /editBooking\(booking\)/);
  assert.match(ui, /handleBookingHistoryClick/);
  assert.match(ui, /handleBookingHistoryKeydown/);
  assert.match(ui, /syncBookingAccordionState\(bookingList\)/);
  execFileSync(process.execPath, ['--check', path.join(root, 'booking/member-ui.js')], { stdio: 'pipe' });
});
