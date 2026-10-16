const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'admin/booking-panel-core.js'), 'utf8');
const cancellation = fs.readFileSync(path.join(root, 'admin/booking-cancellation-sync.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'admin/booking-panel.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');

test('admin user bookings are rendered newest-created first', () => {
  assert.match(core, /function compareBookingsNewestFirst\(a, b\)/);
  assert.match(core, /bookingCreatedTimestamp\(b\) - bookingCreatedTimestamp\(a\)/);
  assert.match(core, /\.sort\(compareBookingsNewestFirst\)/);
  assert.match(core, /booking\?\.createdAt/);
});

test('cancellation request and cancelled lists are newest first', () => {
  assert.match(cancellation, /compareCancellationRequestsNewestFirst/);
  assert.match(cancellation, /compareCancelledNewestFirst/);
  assert.match(cancellation, /requestRows\.slice\(\)\.sort\(compareCancellationRequestsNewestFirst\)/);
  assert.match(cancellation, /cancelledRows\.slice\(\)\.sort\(compareCancelledNewestFirst\)/);
});

test('admin loader versions force clients to receive the latest sorting code', () => {
  assert.match(loader, /layout-stability-20261001-1/);
  assert.match(adminHtml, /booking-panel\.js\?v=[^"']+/);
});
