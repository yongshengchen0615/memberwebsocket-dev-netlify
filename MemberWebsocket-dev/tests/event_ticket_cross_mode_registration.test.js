'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const migration = read('supabase/migrations/20261015194000_event_ticket_cross_mode_exclusivity.sql');

test('a single physical activity claim is serialized across snapshot and general booking writes', () => {
  assert.match(migration, /create trigger general_event_ticket_cross_mode_guard/);
  assert.match(migration, /create trigger snapshot_event_ticket_cross_mode_guard/);
  assert.match(migration, /where c\.member_id=new\.member_id and c\.claim_id=new\.benefit_ref\s+for update/);
  assert.match(migration, /where c\.member_id=new\.member_id and c\.claim_id=v_claim_id for update/);
  assert.match(migration, /EVENT_TICKET_ALREADY_REGISTERED/g);
  assert.match(migration, /submission_mode='accessible'/);
  assert.match(migration, /r\.status in \('pending_upload','awaiting_review'\)/);
  assert.match(migration, /s\.benefit_kind='event'\s+and s\.benefit_ref=v_claim_id and s\.status='pending'/);
});

test('one pending snapshot cannot reserve a ticket held by another snapshot', () => {
  assert.match(migration, /r\.id<>new\.id/);
  assert.match(migration, /requested_benefits @> jsonb_build_array/);
  assert.match(migration, /group by item\.value->>'id' having count\(\*\) > 1/);
  assert.match(migration, /EXISTING_EVENT_TICKET_RESERVATION_CONFLICT/);
});

test('snapshot approval may transfer its own claim into the finalized booking atomically', () => {
  assert.match(migration, /r\.receipt_id is distinct from nullif\(current_setting\('app\.snapshot_receipt_id',true\),''\)/);
  assert.match(read('supabase/migrations/20261015143000_snapshot_pending_future_booking_reservations.sql'), /register_snapshot_receipt_v2/);
});

test('both booking and snapshot catalogs disable already-registered activity claims', () => {
  const catalog = read('supabase/functions/_shared/booking-benefits.ts');
  assert.match(catalog, /pendingSnapshotReceipts/);
  assert.match(catalog, /\.in\('status', \['pending_upload', 'awaiting_review'\]\)/);
  assert.match(catalog, /reservedInSnapshot/);
  assert.match(catalog, /!reservedForOtherBooking && !reservedInSnapshot/);
  assert.match(catalog, /不能重複登記/);
  assert.match(read('booking/booking-benefits.js'), /已登記，不能重複登記/);
  assert.match(read('booking/booking-receipt.js'), /不可重複登記/);
});

test('booking, group booking and snapshot APIs map duplicate registration to 409', () => {
  const message = 'EVENT_TICKET_ALREADY_REGISTERED';
  for (const file of ['supabase/functions/booking-api/index.ts', 'supabase/functions/booking-group-api/index.ts', 'supabase/functions/_shared/booking-ticket-usage.ts']) {
    assert.ok(read(file).includes(message), file);
  }
  assert.match(read('supabase/functions/booking-receipt-api/index.ts'), /bookingTicketUsageError/);
});

test('point ticket rebooking allowance remains isolated from event tickets', () => {
  assert.match(read('supabase/functions/booking-receipt-api/index.ts'), /if\(item\.kind!=="points" \|\| item\.reservedForBooking!==true\) return item/);
  assert.match(migration, /new\.benefit_kind='event'/);
  assert.match(migration, /entry\.value->>'kind'='event'/);
});
