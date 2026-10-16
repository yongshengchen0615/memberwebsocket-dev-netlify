const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('member booking routes group requests without global fetch monkey patching', () => {
  const groupBooking = read('booking/group-booking.js');
  assert.ok(groupBooking.includes("action === 'user.booking.group.slots' ? 'booking-group-slots-api' : 'booking-group-api'"));
  assert.ok(groupBooking.includes('/functions/v1/'));
  assert.ok(!groupBooking.includes('window.fetch ='));
});

test('current member booking runtime scripts have valid JavaScript syntax', () => {
  for (const relativePath of [
    'booking/group-booking.js',
    'booking/member-ui.js',
    'booking/app.js',
    'booking/contact-details.js',
    'booking/calendar-flow.js',
    'booking/service-type-color.js',
  ]) {
    execFileSync(process.execPath, ['--check', path.join(root, relativePath)], { stdio: 'pipe' });
  }
});

test('member booking entrypoint loads the single render pipeline only', () => {
  const html = read('booking/index.html');
  for (const asset of [
    'group-booking.js?v=async-architecture-20260921-1-ticket-service-requirements-20261002-1',
    'member-ui.js?v=test-mode-20260920-1',
    'app.js?v=booking-member-chat-20261003-1',
    'contact-details.js?v=test-mode-20260920-1',
    'calendar-flow.js?v=csp-hardening-20260929-1',
  ]) assert.ok(html.includes(asset), asset);

  assert.ok(!html.includes('booking-confirm-details.js'));
  assert.ok(!html.includes('member-booking-format.js'));
  assert.ok(!html.includes('booking-notice-dedupe.js'));
});

test('add-on companion warnings use the shared confirm-only notice dialog', () => {
  const html = read('booking/index.html');
  const common = read('booking/common.js');
  const app = read('booking/app.js');
  const group = read('booking/group-booking.js');
  const css = read('booking/styles.css');

  assert.ok(html.includes('id="bookingNoticeModal"'));
  assert.ok(html.includes('role="alertdialog"'));
  assert.ok(html.includes('id="confirmBookingNoticeButton"'));
  assert.ok(!html.includes('id="closeBookingNoticeButton"'));
  assert.ok(common.includes('function showNotice(message, options = {})'));
  assert.ok(common.includes("confirmButton.onclick = () =>"));
  assert.ok(app.includes("BookingSystem.showNotice"));
  assert.ok(group.includes("system.showNotice"));
  assert.ok(css.includes('.booking-alert-modal-card'));
  assert.ok(css.includes('.booking-alert-modal-actions .button{width:100%}'));
});

test('booking history is finalized synchronously in the primary render pass', () => {
  const app = read('booking/app.js');
  const memberUi = read('booking/member-ui.js');
  const group = read('booking/group-booking.js');

  assert.ok(group.includes('window.BookingGroupUI = Object.freeze'));
  assert.ok(group.includes('renderBookingHistoryCard'));
  assert.ok(memberUi.includes('window.BookingMemberUI = Object.freeze'));
  assert.ok(memberUi.includes('organizeBookingHistory'));
  assert.ok(app.includes('window.BookingGroupUI?.renderBookingHistoryCard?.(item, booking)'));
  assert.ok(app.includes('window.BookingMemberUI?.organizeBookingHistory?.()'));

  assert.ok(!app.includes('MutationObserver'));
  assert.ok(!group.includes('MutationObserver'));
  assert.ok(!memberUi.includes('MutationObserver'));
});

test('member booking history cards collapse to the four-field summary and keep only one card open', () => {
  const app = read('booking/app.js');
  const memberUi = read('booking/member-ui.js');
  const css = read('booking/booking-history.css');

  for (const label of ['日期', '時間', '總服務時間', '總金額']) {
    assert.ok(app.includes("summaryRow('" + label + "'"));
  }
  assert.ok(memberUi.includes("let expandedBookingId = ''"));
  assert.ok(memberUi.includes('function applyBookingCardAccordionState(card, expanded)'));
  assert.ok(memberUi.includes("bookingList.addEventListener('click', handleBookingHistoryClick)"));
  assert.ok(memberUi.includes("bookingList.addEventListener('keydown', handleBookingHistoryKeydown)"));
  assert.ok(css.includes('booking-history-collapsible:not(.is-expanded)>:not(.booking-item-top):not(.member-booking-format-totals)'));
});

test('legacy booking post-renderer files are removed', () => {
  for (const relativePath of [
    'booking/booking-confirm-details.js',
    'booking/member-booking-format.js',
    'booking/booking-notice-dedupe.js',
  ]) assert.equal(fs.existsSync(path.join(root, relativePath)), false, relativePath);
});


test('editing an existing booking restores its current slot before loading edit availability', () => {
  const app = read('booking/app.js');
  const editStart = app.indexOf('function editBooking(booking)');
  const editEnd = app.indexOf('async function cancelBooking', editStart);
  const editFlow = app.slice(editStart, editEnd);
  assert.ok(editFlow.includes("state.selectedSlot = booking.startTime"));
  assert.ok(editFlow.indexOf('state.selectedSlot = booking.startTime') < editFlow.indexOf('loadSlots();'));
  assert.ok(editFlow.includes("startTime: String(booking.startTime)"));
});
