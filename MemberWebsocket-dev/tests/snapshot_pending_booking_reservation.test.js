const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.join(__dirname, '..');
const edge = fs.readFileSync(path.join(root, 'supabase/functions/booking-receipt-api/index.ts'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261015143000_snapshot_pending_future_booking_reservations.sql'), 'utf8');
const start = edge.indexOf('async function accessibleBenefitCatalog(');
const end = edge.indexOf('async function validateAccessibleBenefits(', start);
assert.ok(start > 0 && end > start, 'snapshot benefit catalog source remains available');
const catalogSource = stripTypeScriptTypes(edge.slice(start, end));

async function preview({ status = 'pending', startAt = '2099-10-16 09:00:00', completed = false, points = 16 } = {}) {
  const id = 'PT-TEST-FUTURE', bookingId = 'booking-001', memberId = 'member-001';
  const queries = {
    booking_benefit_selections: [{ booking_id: bookingId, benefit_ref: id }],
    bookings: [{ id: bookingId, status, start_at: startAt, completed_at: completed ? '2099-01-01' : null }],
  };
  const supabase = {
    rpc: async () => ({ data: 'general', error: null }),
    from(table) {
      const q = {
        select() { return q; },
        eq() { return q; },
        gte() { return q; },
        in: async () => ({ data: queries[table] || [], error: null }),
        lt: async () => ({ data: [], count: 0, error: null }),
      };
      return q;
    },
  };
  const context = vm.createContext({
    loadBookingBenefits: async () => ({ items: [{ kind: 'points', selectionId: id, reservedForBooking: true, pointCost: 5, pointBalance: points, conditionLabel: 'existing rules' }] }),
    snapshotGeoTicketPreview: async (_db, _id, items) => items,
    dbError: error => error,
    selectionLimit: value => Math.max(0, Number(value || 0)),
    String, Date, Number, Boolean, Set, Map, Promise, Array, Math, Intl,
  });
  vm.runInContext(catalogSource, context);
  const result = await context.accessibleBenefitCatalog(supabase, {id:memberId});
  return result.items[0];
}

test('tomorrow pending general booking with 21 total and 5 reserved allows 5-point snapshot', async () => {
  const item = await preview({status:'pending',points:16});
  assert.equal(item.selectable,true);
  assert.equal(item.disabledReason,'');
});
test('confirmed future booking remains eligible when surplus exists', async () => {
  assert.equal((await preview({status:'confirmed'})).selectable,true);
});
test('future pending booking without a second point budget is blocked', async () => {
  const item = await preview({points:4});
  assert.equal(item.selectable,false);
  assert.match(item.disabledReason,/不足以再登記/);
});
test('past or completed booking and cancelled future booking never qualify', async () => {
  for (const config of [{startAt:'2000-01-01 09:00:00'},{completed:true},{status:'cancelled'}]) {
    const item = await preview(config);
    assert.equal(item.selectable,false);
    assert.match(item.disabledReason,/不屬於尚未開始/);
  }
});
test('database migration updates both validators and retains double-redemption guards', () => {
  assert.ok(sql.includes("future.status not in (''pending'',''confirmed'')"));
  assert.ok(sql.includes("b.status in (''pending'',''confirmed'') and b.completed_at is null"));
  assert.match(sql,/SNAPSHOT_PENDING_VALIDATOR_SOURCE_CHANGED/);
  assert.match(sql,/SNAPSHOT_PENDING_REBIND_SOURCE_CHANGED/);
  const original = fs.readFileSync(path.join(root,'supabase/migrations/20261014021208_snapshot_reserved_point_surplus.sql'),'utf8');
  assert.match(original,/budget.amount>greatest\(0,coalesce\(v_balance,0\)-v_reserved_points\)/);
  assert.match(original,/set benefit_ref=v_new_id/);
  assert.match(original,/snapshot_reservation_copy_of/);
});
