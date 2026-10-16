const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const BOOKING_ID = 'f4b9e063-28dc-4e84-8a83-4e41781344c1';

function setup({ booking, confirmed = true } = {}) {
  const requests = [];
  let refreshCount = 0;
  const window = {
    confirm: () => confirmed,
    MemberSystem: {
      request: async (_config, surface, _token, action, body) => {
        requests.push({ surface, action, body });
        if (action.endsWith('.detail')) return { booking };
        if (action.endsWith('.update')) return { change: { bookingId: BOOKING_ID } };
        throw new Error('unexpected request');
      }
    }
  };
  // The existing panel is omitted from this focused unit test; no DOM is needed
  // for the reservation mutation path.
  const document = { getElementById: id => id === 'bookingSelectionPanel' ? {} : null };
  vm.runInNewContext(read('ticket-booking-selections.js'),
    { window, document, crypto: { randomUUID: () => 'aaaaaaab-1111-4111-8111-111111111111' } });
  window.TicketBookingSelections.render([], {
    surface: 'points', config: {}, idToken: 'test-token', refresh: async () => { refreshCount++; }
  });
  return { api: window.TicketBookingSelections, requests, refreshCount: () => refreshCount };
}

test('direct cancellation removes only the chosen pending point ticket', async () => {
  const { api, requests, refreshCount } = setup({ booking: {
    bookingId: BOOKING_ID, updatedAt: '2026-10-13T08:00:00Z', editable: true,
    selections: [
      { kind: 'points', id: 'P-1', status: 'pending' },
      { kind: 'points', id: 'P-2', status: 'pending' },
      { kind: 'event', id: 'E-1', status: 'pending' },
      { kind: 'calendar', id: 'C-1', status: 'pending' },
      { kind: 'points', id: 'P-USED', status: 'redeemed' }
    ]
  } });
  assert.equal(await api.cancelPointTicket(BOOKING_ID, 'P-1'), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].action, 'user.pointcard.booking-selections.detail');
  assert.equal(requests[1].action, 'user.pointcard.booking-selections.update');
  assert.equal(requests[1].body.bookingId, BOOKING_ID);
  assert.equal(requests[1].body.expectedUpdatedAt, '2026-10-13T08:00:00Z');
  assert.match(requests[1].body.requestId, /^BSEL-/);
  assert.equal(JSON.stringify(requests[1].body.benefits),
    JSON.stringify([{ kind: 'points', id: 'P-2' }, { kind: 'event', id: 'E-1' }]));
  assert.equal(refreshCount(), 1);
});

test('cannot release a booked point ticket after settlement or during cancellation review', async () => {
  for (const disabledReason of ['已完成結算', '預約正在申請取消']) {
    const { api, requests } = setup({ booking: {
      bookingId: BOOKING_ID, updatedAt: '2026-10-13T08:00:00Z',
      editable: false, disabledReason,
      selections: [{ kind: 'points', id: 'P-1', status: 'pending' }]
    } });
    await assert.rejects(api.cancelPointTicket(BOOKING_ID, 'P-1'), new RegExp(disabledReason));
    assert.equal(requests.filter(r => r.action.endsWith('.update')).length, 0);
  }
});

test('duplicate cancellation is an idempotent refresh, and declined confirmation makes no request', async () => {
  const booking = { bookingId: BOOKING_ID, editable: true, selections: [] };
  const first = setup({ booking });
  assert.equal(await first.api.cancelPointTicket(BOOKING_ID, 'P-1'), true);
  assert.equal(first.requests.length, 1);
  assert.equal(first.refreshCount(), 1);
  const second = setup({ booking, confirmed: false });
  assert.equal(await second.api.cancelPointTicket(BOOKING_ID, 'P-1'), false);
  assert.equal(second.requests.length, 0);
});

test('ticket-local disclosure exposes independent pending booking cancellation', () => {
  const overview = read('points/pointcard-ticket-overview.js');
  const shared = read('ticket-booking-selections.js');
  assert.match(overview, /createTicketReservationDisclosure/);
  assert.match(overview, /onCancelBooking: async \(context\)/);
  assert.match(overview, /TicketBookingSelections\.cancelPointTicket\(context\.bookingId, offer\.ticketId\)/);
  assert.match(shared, /context\.status === 'pending' && context\.editable/);
  assert.match(shared, /取消此一般預約票券/);
  for (const asset of ['ticket-booking-selections.js', 'pointcard-ticket-overview.js', 'ticket-booking-selections.css']) {
    assert.match(read('points/index.html'), new RegExp(asset.replace(/\./g, '\\.') + '\\?v=[^"]*reservation-disclosure-20261014-1'));
  }
});
