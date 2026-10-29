const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261029194400_admin_phone_overlapping_booking.sql'), 'utf8');
const api = fs.readFileSync(path.join(root, 'supabase/functions/booking-api/index.ts'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'admin/booking-panel-core.js'), 'utf8');

test('AC-001: phone booking is admin-only, validates identity and idempotency', () => {
  assert.match(api, /await authorizeAdmin\(supabase, identity\)/);
  assert.match(api, /action === "admin\.booking\.phone\.create"/);
  assert.match(api, /adminCreatePhoneBooking\(supabase, identity, body\)/);
  assert.match(sql, /from public\.admins[\s\S]*?role\s*=\s*'admin'[\s\S]*?status\s*=\s*'active'/i);
  assert.match(sql, /p_request_id.*PHONE-/s);
  assert.match(sql, /REQUEST_ID_CONFLICT/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /revoke all on function public\.admin_create_phone_booking_request/i);
  assert.match(sql, /grant execute on function public\.admin_create_phone_booking_request[\s\S]*?to service_role/i);
});

test('AC-002: phone entry accepts already occupied slots without weakening member booking guards', () => {
  assert.match(sql, /allow_overlap|p_allow_overlap/i);
  assert.match(sql, /BOOKING_OVERLAP_ACK_REQUIRED/);
  assert.match(sql, /technician_id,.*confirmed_by/s);
  assert.match(sql, /null\s*,\s*p_actor/i);
  assert.doesNotMatch(sql, /drop constraint.*bookings_no_active_technician_overlap/i);
  assert.match(sql, /booking_slot_fits/);
  assert.match(sql, /booking_items/);
  assert.match(sql, /booking_participant_items/);
  assert.match(api, /admin\.booking\.phone\.create/);
  assert.match(ui, /登記電話預約/);
  assert.match(ui, /allowOverlap: true/);
});

test('AC-003: non-member phone booking cannot enter member settlement or benefit flows', () => {
  assert.match(sql, /member_id.*null/i);
  assert.match(ui, /isPhoneBooking/);
  assert.match(ui, /booking\.bookingSource === 'phone'/);
  assert.match(api, /bookingSource:.*PHONE-/);
  assert.match(sql, /BOOKING_PHONE_CREATED/);
  assert.match(sql, /platform_private\.business_templates/);
  assert.match(sql, /platform_private\.business_sql/);
});

test('AC-004: browser source stays syntactically valid', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(root, 'admin/booking-panel-core.js')]));
});
