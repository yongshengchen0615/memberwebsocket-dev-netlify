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


test('AC-001: admin booking details display the full canonical booking ID for member and phone reservations', () => {
  const vm = require('node:vm');
  const start = core.indexOf('  function renderBookingSummary(');
  const end = core.indexOf('  function renderParticipantDetails(', start);
  assert.ok(start >= 0 && end > start, 'booking summary renderer must be available');
  const document = {
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(), className: '', textContent: '', dataset: {}, attributes: {}, children: [],
        append(...nodes) { this.children.push(...nodes); },
        appendChild(node) { this.children.push(node); return node; },
        setAttribute(name, value) { this.attributes[name] = value; },
      };
    },
  };
  const context = {
    document,
    isPhoneBooking: (booking) => booking.contactSource === 'phone',
    isFrontdeskReplacement: () => false,
    bookingContactName: (booking) => booking.contactName || '測試預約人',
    formatBookingDateSummary: (date) => date,
    formatMoney: (amount) => String(amount),
    renderParticipantDetails: () => document.createElement('section'),
  };
  vm.runInNewContext(core.slice(start, end) + '\nthis.renderBookingSummary = renderBookingSummary;', context);
  const descendants = (node) => [node, ...(node.children || []).flatMap(descendants)];
  const bookingId = '123e4567-e89b-42d3-a456-426614174000';
  for (const contactSource of ['member', 'phone']) {
    const booking = {
      bookingId, contactSource, bookingDate: '2026-11-25', startTime: '10:00', endTime: '11:00',
      memberDisplayName: '會員甲', memberCode: 'M001', contactName: '王先生', contactPhone: '0912345678',
    };
    const summary = context.renderBookingSummary(booking, {}, false);
    const idField = descendants(summary).find((node) => node.className.split(' ').includes('booking-id-meta'));
    assert.ok(idField, `missing booking number for ${contactSource}`);
    assert.equal(descendants(idField).find((node) => node.tagName === 'STRONG')?.textContent, bookingId);
    const copy = descendants(idField).find((node) => node.className === 'booking-id-copy-button');
    assert.ok(copy, 'booking number should have a dedicated copy action');
    assert.equal(copy.type, 'button');
  }
});

test('AC-002: copy booking ID uses only canonical booking ID and provides feedback', () => {
  const copySource = fs.readFileSync(path.join(root, 'booking-copy-format.js'), 'utf8');
  assert.match(copySource, /\.booking-id-copy-button/);
  assert.match(copySource, /copyText\(bookingId\)/);
  assert.match(copySource, /已複製/);
  assert.match(copySource, /複製失敗/);
});
