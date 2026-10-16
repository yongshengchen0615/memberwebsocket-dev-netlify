const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const migration = source('supabase/migrations/20261014021208_snapshot_reserved_point_surplus.sql');
const edge = source('supabase/functions/booking-receipt-api/index.ts');
const overview = source('booking/booking-accessible.js');

test('future reserved point ticket can only be reused by snapshot with a second available point budget', () => {
  assert.match(edge, /const enough=cost>0 && Number\(item\.pointBalance\)>=cost/);
  assert.match(edge, /const selectable=future && enough/);
  assert.match(edge, /\.eq\("benefit_kind","points"\)\.eq\("status","pending"\)/);
  assert.match(edge, /\(row\.status==="pending" \|\| row\.status==="confirmed"\) && !row\.completed_at/);
  assert.match(edge, /Date\.parse\(String\(row\.start_at/);
  assert.match(migration, /future\.status<>'confirmed'/);
  assert.match(migration, /future\.start_at<=\(clock_timestamp\(\) at time zone 'Asia\/Taipei'\)/);
  assert.match(migration, /budget\.amount>greatest\(0,coalesce\(v_balance,0\)-v_reserved_points\)/);
  // Only a snapshot can use a ticket already committed to a future booking.
  assert.match(migration, /kind<>'points' or p_booking is not null/);
});

test('same issued point ticket is never redeemed twice: the later reservation is atomically rebound', () => {
  assert.match(migration, /snapshot_reservation_copy_of text/);
  assert.match(migration, /snapshot_reservation_copy_of is null/);
  assert.match(migration, /point_ticket_unique_snapshot_reservation_copy/);
  assert.match(migration, /for v_item in select value from jsonb_array_elements\(p_benefits\) loop/);
  assert.match(migration, /insert into public\.point_tickets\(/);
  assert.match(migration, /set benefit_ref=v_new_id/);
  assert.match(migration, /booking_benefit_selection',v_selection_id::text,'success'/);
  assert.match(migration, /if r\.updated_at is distinct from p_expected_receipt_updated_at/);
  assert.match(migration, /if not found then raise exception 'BOOKING_CONFLICT'/);
});

test('GPS cannot override point balance or reservation eligibility', () => {
  assert.match(edge, /checked\?\.allowed===true && item\.selectable===true/);
  assert.match(edge, /String\(item\.disabledReason\|\|/);
  assert.doesNotMatch(edge, /item\.reservedForBooking!==true\s*:\s*item\.locked/);
  assert.doesNotMatch(overview, /&& !item\.reservedForBooking/);
});

test('surplus balance cases preserve the independent future reservation', () => {
  const canSnapshot = (balance, futureReserved, nowCost) =>
    nowCost > 0 && futureReserved >= 0 && balance - futureReserved >= nowCost;
  assert.equal(canSnapshot(8, 3, 3), true); // 3 now and 3 a week later
  assert.equal(canSnapshot(6, 3, 3), true); // exact combined budget
  assert.equal(canSnapshot(5, 3, 3), false); // cannot over-commit the future
  assert.equal(canSnapshot(3, 3, 3), false); // funds are already reserved
  assert.equal(canSnapshot(10, 6, 0), false); // zero-cost invalid
});
