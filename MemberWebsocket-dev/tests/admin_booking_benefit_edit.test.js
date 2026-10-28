const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('admin booking ticket edits are atomic and concurrency guarded', () => {
  const migration = read('supabase/migrations/20261003000500_admin_booking_benefit_edit.sql');
  assert.match(migration, /admin_replace_booking_benefit_selections_request/);
  assert.match(migration, /for update/);
  assert.match(migration, /BOOKING_CONFLICT/);
  assert.match(migration, /BOOKING_CANCELLATION_PENDING/);
  assert.match(migration, /replace_booking_benefit_selections_request/);
  assert.match(migration, /BOOKING_BENEFITS_UPDATED/);
  assert.match(migration, /revoke all on function public\.admin_replace_booking_benefit_selections_request/);
  assert.match(migration, /grant execute on function public\.admin_replace_booking_benefit_selections_request[\s\S]*to service_role/);
});

test('admin operations reuse canonical booking benefit eligibility and server-side validation', () => {
  const source = read('supabase/functions/booking-admin-operations/index.ts');
  assert.match(source, /loadBookingBenefits/);
  assert.match(source, /admin\.booking\.benefits\.list/);
  assert.match(source, /admin\.booking\.benefits\.update/);
  assert.match(source, /admin_replace_booking_benefit_selections_request/);
  assert.match(source, /BOOKING_BENEFIT_SERVICE_REQUIRED/);
  assert.match(source, /POINT_TICKET_INSUFFICIENT_POINTS/);
  assert.match(source, /booking_benefit_selections_one_pending_ticket_idx/);
  assert.match(source, /管理端不可代替會員領取/);
  assert.doesNotMatch(source, /admin\.booking\.benefits\.update[\s\S]{0,4000}claim_event_ticket/);
});

test('admin booking UI can add, remove and replace already-owned reservation tickets', () => {
  const source = read('admin/booking-panel-core.js');
  assert.match(source, /修改預約票券/);
  assert.match(source, /admin\.booking\.benefits\.list/);
  assert.match(source, /admin\.booking\.benefits\.update/);
  assert.match(source, /尚未領取的活動票券不會由管理端代領/);
  assert.match(source, /BOOKING_BENEFIT_SERVICE_REQUIRED|bookingBenefitServiceBlocked/);
  assert.match(source, /bookingBenefitPointBalance/);
  assert.match(source, /expectedUpdatedAt: freshBooking\.updatedAt/);
});

test('admin booking ticket editor assets are cache-busted', () => {
  assert.match(read('admin/index.html'), /booking-panel\.js\?v=booking-operations-split-20261003-1-ticket-source-20261004-1-ticket-card-ui-20261004-1/);
  const htmlVersion = /booking-panel\.js\?v=([^"']+)/.exec(read('admin/index.html'))?.[1];
  const coreVersion = /booking-panel-core\.js', '([^']+)'/.exec(read('admin/booking-panel.js'))?.[1];
  assert.ok(htmlVersion && coreVersion, 'booking loader versions must be present');
  assert.equal(htmlVersion, coreVersion, 'HTML must load the same booking core version');
  assert.match(coreVersion, /-controls-20261010-2-snapshot-geofence-20261012-1-release-20261014-1-no-show-history-20261014-1-hide-early-hint-20261015-1-service-ticket-rule-20261015-1-booking-risk-20261021-1-risk-tab-20261023-1-risk-ux-20261023-2-layout-20261028-1$/, 'latest booking ticket rule assets must not be cached');
});
