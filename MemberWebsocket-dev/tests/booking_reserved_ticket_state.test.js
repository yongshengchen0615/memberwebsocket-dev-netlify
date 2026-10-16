const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('booking-reserved consumable tickets have a single authoritative pending reservation', () => {
  const migration = read('supabase/migrations/20261002194500_booking_reserved_ticket_state.sql');
  assert.match(migration, /create unique index if not exists booking_benefit_selections_one_pending_ticket_idx/);
  assert.match(migration, /where status = 'pending'/);
  assert.match(migration, /benefit_kind in \('points','event'\)/);
  assert.match(migration, /array\['booking','points','event','admin'\]/);
  assert.match(migration, /after insert or update or delete on public\.booking_benefit_selections/);
});

test('member API exposes booked ticket state and blocks direct redemption', () => {
  const api = read('supabase/functions/api/index.ts');

  assert.match(api, /reservedForBooking: Boolean\(reservedForBooking\)/);
  assert.match(api, /reservedPointTicketIds\.has\(String\(ticket\.ticket_id \|\| ""\)\)/);
  assert.match(api, /reservedEventClaimIds\.has\(String\(claimRow\.claim_id \|\| ""\)\)/);
  assert.match(api, /canUse: Boolean\(claim && claim\.status === "available".*!reservedForBooking.*bookingOptions/);
  const shared = read('supabase/functions/_shared/booking-ticket-usage.ts');
  assert.match(api, /redeem_member_tickets_for_booking_request/);
  assert.match(shared, /BOOKING_BENEFIT_RESERVED/);
  assert.match(shared, /已預約使用/);

});

test('batch redemption endpoints also reject tickets reserved for bookings', () => {
  const pointApi = read('supabase/functions/pointcard-extension-api/index.ts');
  const eventApi = read('supabase/functions/event-ticket-extension-api/index.ts');

  const migration = read('supabase/migrations/20261006023020_booking_ticket_usage_consistency.sql');
  assert.match(migration, /BOOKING_BENEFIT_RESERVED/);
  assert.match(migration, /status='pending'/);
  for (const source of [pointApi, eventApi]) {
    assert.match(source, /redeem_member_tickets_for_booking_request/);
    assert.match(source, /bookingTicketUsageError/);
  }
});

test('member ticket surfaces render booked tickets as 已預約使用', () => {
  const points = read('points/pointcard-ticket-overview.js');
  const event = read('event/app.js');
  const eventCss = read('event/styles.css') + read('event-ticket-ui.css');

  assert.match(points, /reservedForBooking/);
  assert.match(points, /statusText = '已預約使用'/);
  assert.match(points, /selectText\.textContent = offer\.reservedForBooking && offer\.pendingSnapshot/);
  assert.match(points, /\? '預約與快照待審核'/);
  assert.match(points, /: offer\.reservedForBooking \? '已預約使用' : offer\.pendingSnapshot \? '快照待審核'/);

  assert.match(event, /reserved \? '已預約使用'/);
  assert.match(event, /已選入一般預約，將於服務完成時自動核銷/);
  assert.match(event, /offer\.history \|\| offer\.reservedForBooking/);
  assert.match(eventCss, /\.event-ticket-state\.reserved/);
});

test('reserved ticket assets use fresh cache versions', () => {
  assert.match(read('points/index.html'), /pointcard-ticket-overview\.js\?v=ticket-unlimited-zero-20261002-1/);
  assert.match(read('event/index.html'), /styles\.css\?v=booking-reserved-20261002-1/);
  assert.match(read('event/index.html'), /app\.js\?v=booking-reserved-20261002-1/);
});
