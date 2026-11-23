const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const bookingId = 'f4b9e063-28dc-4e84-8a83-4e41781344c1';
const claimId = 'EC-OWNED-1';
const selections = [
  { kind: 'points', id: 'PT-1', status: 'pending' },
  { kind: 'event', id: 'EC-OTHER', status: 'pending' },
  { kind: 'event', id: 'EC-USED', status: 'redeemed' },
];
function fixture({ confirmed = true, editable = true, selectable = true, alreadySelected = false, failUpdate = false } = {}) {
  const requests = [];
  let refreshed = 0;
  const window = {
    MemberSystem: {
      request: async (_config, surface, _token, action, body) => {
        requests.push({ surface, action, body });
        if (action.endsWith('.detail')) return {
          booking: { bookingId, status: confirmed ? 'confirmed' : 'pending', editable,
            updatedAt: '2026-11-23T09:00:00Z',
            selections: alreadySelected ? [...selections, { kind: 'event', id: claimId, status: 'pending' }] : selections },
          options: { items: [{ kind: 'event', selectionId: claimId, selectable }] },
        };
        if (action.endsWith('.update')) {
          if (failUpdate) throw Object.assign(Error('BOOKING_CONFLICT'), { code: 'BOOKING_CONFLICT' });
          return {};
        }
        throw Error('unexpected action: ' + action);
      },
    },
  };
  const document = { getElementById: () => null };
  vm.runInNewContext(read('ticket-booking-selections.js'), {
    window, document, crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  });
  window.TicketBookingSelections.render([], { surface: 'event', config: {}, idToken: 'test-token',
    refresh: async () => { refreshed++; } });
  return { api: window.TicketBookingSelections, requests, get refreshed() { return refreshed; } };
}
test('AC-001: UI shows bind action only with server-provided eligible confirmed booking', () => {
  const ui = read('event/app.js');
  assert.match(ui, /function canBindExistingBooking\(offer\)/);
  assert.match(ui, /Array\.isArray\(offer\.eligibleBookings\)/);
  assert.match(ui, /booking\.bookingId !== 'no-booking'/);
  assert.match(ui, /button\.dataset\.ticketAction = bindable \? 'bind-booking'/);
  assert.match(ui, /bindable \? '綁定已有預約使用'/);
  assert.doesNotMatch(ui, /'查看使用條件'/);
  assert.match(ui, /if \(canBindExistingBooking\(offer\)\) return bindTicketToExistingBooking\(offer\)/);
  assert.match(ui, /TicketBookingSelections\.bindEventTicket\(bookingId, offer\.claim\.claimId\)/);
});
test('AC-002: bind preserves unrelated reservations and does not redeem immediately', async () => {
  const f = fixture();
  assert.equal(await f.api.bindEventTicket(bookingId, claimId), true);
  assert.equal(f.refreshed, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].action, 'user.event.booking-selections.detail');
  assert.equal(f.requests[1].action, 'user.event.booking-selections.update');
  assert.deepEqual(JSON.parse(JSON.stringify(f.requests[1].body.benefits)), [
    { kind: 'points', id: 'PT-1' }, { kind: 'event', id: 'EC-OTHER' }, { kind: 'event', id: claimId },
  ]);
  assert.equal(f.requests[1].body.expectedUpdatedAt, '2026-11-23T09:00:00Z');
  assert.match(f.requests[1].body.requestId, /^BSEL-/);
});
test('AC-003: reject unconfirmed, uneditable, or no-longer-eligible bookings', async () => {
  for (const scenario of [{ confirmed: false }, { editable: false }, { selectable: false }]) {
    const f = fixture(scenario);
    await assert.rejects(f.api.bindEventTicket(bookingId, claimId));
    assert.equal(f.requests.filter(r => r.action.endsWith('.update')).length, 0);
  }
});
test('AC-004: already selected ticket is idempotent', async () => {
  const f = fixture({ alreadySelected: true });
  assert.equal(await f.api.bindEventTicket(bookingId, claimId), true);
  assert.equal(f.requests.filter(r => r.action.endsWith('.update')).length, 0);
  assert.equal(f.refreshed, 1);
});
test('AC-005: reject synthetic no-booking and preserve state on update conflict', async () => {
  const invalid = fixture();
  await assert.rejects(invalid.api.bindEventTicket('no-booking', claimId));
  assert.equal(invalid.requests.length, 0);
  const conflict = fixture({ failUpdate: true });
  await assert.rejects(conflict.api.bindEventTicket(bookingId, claimId), /BOOKING_CONFLICT/);
  assert.equal(conflict.refreshed, 0);
});
