const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const booking = (overrides = {}) => ({
  bookingId: 'f4b9e063-28dc-4e84-8a83-4e41781344c1',
  bookingDate: '2026-10-21',
  startAt: '2026-10-21T09:00:00',
  endAt: '2026-10-21T10:11:00',
  startTime: '09:00',
  endTime: '10:11',
  status: 'pending',
  editable: true,
  serviceSlots: [{
    bookingDate: '2026-10-21',
    startAt: '2026-10-21T09:00:00',
    endAt: '2026-10-21T10:01:00',
    startTime: '09:00',
    endTime: '10:01',
  }],
  ...overrides,
});

function disclosure(context, extra = {}) {
  const document = {
    createElement(tag) {
      return {
        tag, children: [], attributes: {}, textContent: '', className: '',
        append(...nodes) { this.children.push(...nodes); },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener() {},
      };
    },
  };
  const window = {};
  vm.runInNewContext(read('ticket-booking-selections.js'), { document, window });
  return window.TicketBookingSelections.createTicketReservationDisclosure({
    title: '100優惠',
    bookingSelections: [context],
    onCancelBooking: () => {},
    ...extra,
  });
}

test('one-person ticket reservation displays the complete booking interval, not the shorter technician slot', () => {
  // Real regression shape: booking items 61 minutes + in-store service 10 minutes.
  // booking_participant_reservations ends at 10:01; bookings ends at 10:11.
  const card = disclosure(booking());
  const row = card.children[1].children[0];
  assert.equal(row.children[1].textContent, '已選於 2026-10-21 09:00–10:11');
  assert.equal(row.children[2].attributes['aria-label'],
    '取消「100優惠」於 2026-10-21 09:00–10:11 的一般預約票券');
  assert.equal(row.children[2].textContent, '取消此一般預約票券');
});

test('multiple technician service slots do not replace the full booking range', () => {
  const card = disclosure(booking({
    serviceSlots: [
      { startAt: '2026-10-21T09:00', endAt: '2026-10-21T10:01', startTime: '09:00', endTime: '10:01' },
      { startAt: '2026-10-21T09:00', endAt: '2026-10-21T09:45', startTime: '09:00', endTime: '09:45' },
    ],
  }));
  assert.equal(card.children[1].children[0].children[1].textContent,
    '已選於 2026-10-21 09:00–10:11');
});

test('legacy payload without an overall booking time falls back to participant slot details', () => {
  const card = disclosure(booking({ endTime: '', endAt: '' }));
  assert.equal(card.children[1].children[0].children[1].textContent,
    '已選於 2026-10-21 09:00–10:01');
});

test('overnight full booking range uses the following day instead of the earlier service slot end', () => {
  const card = disclosure(booking({
    startAt: '2026-10-21T23:30:00', endAt: '2026-10-22T00:40:00',
    startTime: '23:30', endTime: '00:40',
    serviceSlots: [{
      startAt: '2026-10-21T23:30:00', endAt: '2026-10-22T00:30:00',
      startTime: '23:30', endTime: '00:30',
    }],
  }));
  assert.equal(card.children[1].children[0].children[1].textContent,
    '已選於 2026-10-21 23:30–翌日 00:40');
});

test('redeemed reservations remain non-cancellable while still showing the full booking interval', () => {
  const card = disclosure(booking({ status: 'redeemed', editable: false }));
  const row = card.children[1].children[0];
  assert.equal(row.children[1].textContent, '已選於 2026-10-21 09:00–10:11 · 已核銷');
  assert.equal(row.children[2].className, 'ticket-reservation-reason');
  assert.equal(row.children[2].textContent, '此票券已核銷，無法取消');
});

test('both point-card and event-ticket pages load the refreshed shared time renderer', () => {
  for (const page of ['points/index.html', 'event/index.html']) {
    assert.match(read(page), /ticket-booking-selections\.js\?v=[^"]*booking-range-20261015-1/);
  }
  assert.match(read('admin/booking-panel-core.js'), /booking-received-datetime/);
  assert.match(read('supabase/functions/_shared/booking-selection-context.ts'),
    /startTime: b\.startTime, endTime: b\.endTime/);
});
