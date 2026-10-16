const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = filename => fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
const BOOKING_ID = 'f4b9e063-28dc-4e84-8a83-4e41781344c1';

test('both ticket surfaces show independent expandable booking and snapshot rows', () => {
  const shared = read('ticket-booking-selections.js');
  const points = read('points/pointcard-ticket-overview.js');
  const event = read('event/app.js');
  for (const re of [/node\('details'/, /node\('summary'/, /一般預約/, /快照預約/,
    /context\.status === 'pending' && context\.editable/, /取消此快照票券/,
    /snapshots\.length/, /onCancelBooking/, /onCancelSnapshot/]) assert.match(shared, re);
  for (const source of [points, event]) {
    assert.match(source, /createTicketReservationDisclosure/);
    assert.match(source, /expandedReservationTickets/);
    assert.match(source, /onCancelBooking: async/);
    assert.match(source, /onCancelSnapshot: async/);
    assert.match(source, /pendingSnapshots: offer\.pendingSnapshots/);
  }
  assert.match(read('ticket-booking-selections.css'), /ticket-reservation-summary:focus-visible/);
  assert.match(shared, /提交時間/);
  assert.ok(shared.includes("timeZone: 'Asia/Taipei'"));
  const api = read('supabase/functions/api/index.ts');
  assert.match(api, /receipt_id,created_at,updated_at,requested_benefits/);
  assert.ok(api.includes('createdAt:String(receipt.created_at)'));
});

test('event cancellation updates only the chosen pending event ticket and keeps points', async () => {
  const requests = [];
  const window = {
    confirm: () => true,
    MemberSystem: { request: async (_config, surface, _token, action, body) => {
      requests.push({ surface, action, body });
      if (action.endsWith('.detail')) return { booking: {
        bookingId: BOOKING_ID, editable: true, updatedAt: '2026-10-14T01:10:00Z',
        selections: [
          { kind: 'points', id: 'PT-1', status: 'pending' },
          { kind: 'event', id: 'EC-1', status: 'pending' },
          { kind: 'event', id: 'EC-2', status: 'pending' },
          { kind: 'event', id: 'EC-USED', status: 'redeemed' },
        ]
      } };
      if (action.endsWith('.update')) return {};
      throw Error('unexpected');
    }}
  };
  const document = { getElementById: () => null };
  vm.runInNewContext(read('ticket-booking-selections.js'), {
    window, document, crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  });
  let refreshed = 0;
  window.TicketBookingSelections.render([], { surface: 'event', config: {}, idToken: 'mock', refresh: async () => { refreshed++; } });
  assert.equal(await window.TicketBookingSelections.cancelTicket(BOOKING_ID, 'event', 'EC-1'), true);
  assert.equal(refreshed, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].action, 'user.event.booking-selections.detail');
  assert.equal(requests[1].action, 'user.event.booking-selections.update');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[1].body.benefits)), [
    { kind: 'points', id: 'PT-1' }, { kind: 'event', id: 'EC-2' },
  ]);
  assert.equal(requests[1].body.expectedUpdatedAt, '2026-10-14T01:10:00Z');
});

test('event snapshot endpoint restricts receipt ownership and updates only event benefit', () => {
  const sql = read('supabase/migrations/20261014011701_member_cancel_snapshot_event_ticket.sql');
  for (const re of [/security invoker/i, /member_id = v_member_id/, /submission_mode = 'accessible'/,
    /status <> 'awaiting_review'/, /updated_at is distinct from p_expected_updated_at/,
    /entry\.item->>'kind' = 'event' and entry\.item->>'id' = p_ticket_id/,
    /snapshot_location_verified_tickets = v_verified/, /revoke all on function/,
    /grant execute on function.*member_cancel_snapshot_event_ticket_request/s])
    assert.match(sql, re);
  assert.doesNotMatch(sql, /delete from public\.booking_receipts/);
  const api = read('supabase/functions/api/index.ts');
  for (const re of [/user\.event\.snapshot-ticket\.cancel/, /member_cancel_snapshot_event_ticket_request/,
    /pendingSnapshotsByClaim/, /pendingSnapshots: snapshotByPointTicket\.get/, /!pendingSnapshots\.length/])
    assert.match(api, re);
});

test('standalone reservation selector stays on points but is absent on event tickets', () => {
  function node() {
    return {
      children: [],
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; },
      setAttribute() {},
      addEventListener() {}
    };
  }
  const eventHost = node();
  const pointsHost = node();
  const document = {
    getElementById(id) {
      if (id === 'eventView') return eventHost;
      if (id === 'pointsView') return pointsHost;
      return null;
    },
    createElement: node
  };
  const window = {};
  vm.runInNewContext(read('ticket-booking-selections.js'), { window, document });
  window.TicketBookingSelections.render([], { surface: 'event', config: {}, idToken: 'test', refresh() {} });
  assert.equal(eventHost.children.length, 0, 'event page must not mount the standalone reservation editor');
  window.TicketBookingSelections.render([], { surface: 'points', config: {}, idToken: 'test', refresh() {} });
  assert.equal(pointsHost.children.length, 1, 'points page must retain its reservation editor');
  assert.equal(pointsHost.children[0].id, 'bookingSelectionPanel');
});
