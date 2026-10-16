const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('database protects point balances reserved by pending bookings', () => {
  const migration = read('supabase/migrations/20261002210000_booking_point_reservation_balance.sql');
  assert.match(migration, /create or replace function public\.protect_booking_reserved_point_balance/);
  assert.match(migration, /b\.status = 'pending'/);
  assert.match(migration, /pt\.point_card_id = new\.point_card_id/);
  assert.match(migration, /point_balances_booking_reservation_guard/);
  assert.match(migration, /before insert or update of member_id, point_card_id, stamps/);
  assert.match(migration, /raise exception 'INSUFFICIENT_POINTS'/);
});

test('point reservation validation spans all pending bookings for a member and card', () => {
  const migration = read('supabase/migrations/20261002210000_booking_point_reservation_balance.sql');
  const start = migration.indexOf('create or replace function public.validate_booking_point_ticket_balance');
  const end = migration.indexOf('drop trigger if exists booking_point_ticket_balance_guard');
  const validator = migration.slice(start, end);
  assert.match(validator, /b\.member_id = new\.member_id/);
  assert.match(validator, /b\.status = 'pending'/);
  assert.doesNotMatch(validator, /b\.booking_id = new\.booking_id/);
});

test('booking completion transaction releases only its own hold before point redemption', () => {
  const migration = read('supabase/migrations/20261002210000_booking_point_reservation_balance.sql');
  const releaseAt = migration.indexOf("set status='redeemed'");
  const redeemAt = migration.indexOf('v_point_result := public.redeem_point_tickets');
  assert.ok(releaseAt >= 0 && redeemAt > releaseAt);
  assert.match(migration, /where id=any\(v_point_selection_ids\)/);
});

test('booking benefits calculate spendable points after other booking reservations', () => {
  const shared = read('supabase/functions/_shared/booking-benefits.ts');
  const api = read('supabase/functions/api/index.ts');
  const common = read('booking/common.js');
  const benefits = read('booking/booking-benefits.js');
  const app = read('booking/app.js');

  assert.match(shared, /pendingPointSelections/);
  assert.match(shared, /otherBookingReserved/);
  assert.match(shared, /totalPointBalance - otherBookingReserved/);
  assert.match(shared, /reservedForOtherBooking/);
  assert.match(api, /eq\("member_id", member\.id\)/);
  assert.match(api, /currentBookingId/);
  assert.match(common, /bookingBenefits\(config, idToken, bookingId = ''\)/);
  assert.match(benefits, /currentBookingId/);
  assert.match(benefits, /setBookingContext/);
  assert.match(app, /setBookingContext\?\.\(booking\.bookingId\)/);
});

test('point card bootstrap and UI expose spendable and reserved balances', () => {
  const api = read('supabase/functions/api/index.ts');
  const points = read('points/app.js');
  const ticketOverview = read('points/pointcard-ticket-overview.js');

  assert.match(api, /reservedStampsByCard/);
  assert.match(api, /reservedStamps,/);
  assert.match(api, /availableStamps,/);
  assert.match(points, /card\.availableStamps/);
  assert.match(points, /點可用 · .*點已預約/);
  assert.match(points, /已預約使用，將於服務完成時自動核銷/);
  assert.match(points, /totalStamps,/);
  assert.match(points, /reservedStamps,/);
  assert.match(ticketOverview, /card\.availableStamps \?\? card\.stamps/);
  assert.match(ticketOverview, /目前可用/);
});

test('updated booking and point assets are cache busted', () => {
  const booking = read('booking/index.html');
  const points = read('points/index.html');
  assert.match(booking, /common\.js\?v=booking-member-chat-20261003-1/);
  assert.match(booking, /booking-benefits\.js\?v=ticket-service-requirements-20261002-1/);
  assert.match(booking, /app\.js\?v=booking-member-chat-20261003-1/);
  assert.match(points, /app\.js\?v=point-transfer-realtime-20261001-2-booking-point-reservation-20261002-1/);
  assert.match(points, /pointcard-ticket-overview\.js\?v=ticket-unlimited-zero-20261002-1/);
});
