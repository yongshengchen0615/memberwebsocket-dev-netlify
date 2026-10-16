const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (filename) => fs.readFileSync(path.join(root, filename), 'utf8');
const sql = read('supabase/migrations/20261015190000_ticket_service_based_booking_requirement.sql');

test('a service-restricted ticket requires a booking; tickets without service selections can be used directly', () => {
  assert.match(sql, /if not public\.ticket_has_service_requirement\(p_member_id,t\.kind,t\.ref\) and not exists/);
  assert.match(sql, /p_booking_id is null and public\.ticket_has_service_requirement\(v_member\.id,p_kind,v_ref\)/);
  assert.match(sql, /BOOKING_TICKET_CONFIRMATION_REQUIRED/);
  assert.match(sql, /booking_ticket_matches_services\(p_booking_id,v_member\.id,p_kind,v_ref\)/);
  assert.match(read('supabase/migrations/20261006023020_booking_ticket_usage_consistency.sql'), /BOOKING_BENEFIT_SERVICE_REQUIRED/);
  assert.match(sql, /TICKET_SERVICE_OPTIONS_GLOBAL_GATE_CHANGED/);
  assert.match(sql, /TICKET_SERVICE_REDEEM_GLOBAL_GATES_CHANGED/);
  assert.match(sql, /TICKET_SERVICE_REDEEM_MATCH_GUARD_CHANGED/);
});

test('ownership, replay, pending reservation, GPS and privileged execution remain protected', () => {
  const base = read('supabase/migrations/20261006023020_booking_ticket_usage_consistency.sql');
  assert.match(base, /BOOKING_NOT_OWNED/);
  assert.match(base, /REQUEST_ID_CONFLICT/);
  assert.match(base, /BOOKING_BENEFIT_RESERVED/);
  assert.match(base, /redeem_point_tickets_with_location/);
  assert.match(base, /redeem_event_tickets_with_location/);
  assert.match(sql, /revoke all on function public\.redeem_member_tickets_for_booking_request/);
  assert.match(sql, /to service_role/);
  assert.doesNotMatch(sql, /replace\(v_definition,[^;]*BOOKING_BENEFIT_RESERVED/);
  assert.doesNotMatch(sql, /register_snapshot_receipt_v2|validate_snapshot_ticket_selection/i);
});

test('admin removes the obsolete global switch and snapshot remains a separate flow', () => {
  const core = read('admin/booking-panel-core.js');
  const html = read('admin/index.html');
  assert.doesNotMatch(core, /bookingAdminTicketBookingRequired|handleTicketBookingPolicyNavigation|ticketBookingRequired:/);
  assert.doesNotMatch(html, /data-open-ticket-booking-policy/);
  assert.match(html, /未指定項目可直接使用。快照模式維持原規則/);
  assert.match(core, /snapshotLocationRequired: els\.bookingAdminSnapshotLocationRequired\.checked/);
  assert.match(read('supabase/functions/booking-receipt-api/index.ts'), /data=\{\.\.\.catalog,ticketBookingRequired:false\}/);
});
