const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261029194400_admin_phone_overlapping_booking.sql'), 'utf8');
const api = fs.readFileSync(path.join(root, 'supabase/functions/booking-api/index.ts'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'admin/booking-panel-core.js'), 'utf8');
const groupSlots = fs.readFileSync(path.join(root, 'supabase/functions/booking-group-slots-api/index.ts'), 'utf8');
const memberUi = fs.readFileSync(path.join(root, 'booking/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'admin/booking-panel.css'), 'utf8');

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

test('AC-002: admin phone booking rejects occupied time until cancellation', () => {
  assert.match(sql, /create trigger bookings_phone_no_overlap/i);
  assert.match(sql, /booking_guard_phone_time_conflict/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(new.booking_date::text,0\)\)/);
  assert.match(sql, /old_booking.status in \('pending','confirmed'\)/);
  assert.match(sql, /old_booking.start_at < v_end/);
  assert.match(sql, /old_booking.end_at > v_start/);
  assert.match(sql, /PHONE_BOOKING_CONFLICT/);
  assert.match(sql, /BOOKING_SLOT_TAKEN/);
  assert.doesNotMatch(sql, /drop constraint.*bookings_no_active_technician_overlap/i);
  assert.doesNotMatch(sql, /p_allow_overlap|BOOKING_OVERLAP_ACK_REQUIRED/i);
  assert.match(sql, /booking_slot_fits/);
  assert.match(sql, /booking_items/);
  assert.match(sql, /booking_participant_items/);
  assert.match(api, /admin\.booking\.phone\.create/);
  assert.match(api, /請先取消原預約/);
  assert.doesNotMatch(api, /p_allow_overlap|body.allowOverlap/);
  assert.match(ui, /登記電話預約/);
  assert.match(ui, /bookingRequest\('admin\.booking\.phone\.slots'/);
  assert.match(ui, /data-phone-slot-grid/);
  assert.match(ui, /button\.disabled = slot\.available !== true/);
  assert.match(ui, /請先取消原預約/);
  assert.doesNotMatch(ui, /allowOverlap: true|data-phone-overlap/);
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

test('AC-005: phone reservation uses member-equivalent service duration and grey server slots', () => {
  assert.match(api, /async function adminPhoneSlots/);
  assert.match(api, /generateSlots\(supabase/);
  assert.match(api, /storeServiceMinutes = Number\(items\.find/);
  assert.match(api, /unavailableReason: overlap \? "occupied"/);
  assert.match(ui, /data-phone-service-picker/);
  assert.match(ui, /data-phone-selected-list/);
  assert.match(ui, /data-phone-duration/);
  assert.match(ui, /total !== itemMinutes\(\) \+ store/);
  assert.match(ui, /isPhoneBooking\(booking\) \? booking\.totalDurationMinutes/);
  assert.match(ui, /selectedItems\(\)/);
  assert.match(css, /\.booking-phone-slot:disabled/);
});

test('AC-006: member single and group availability include active phone reservations', () => {
  assert.match(api, /\.in\("status", \["pending", "confirmed"\]\)/);
  assert.match(api, /const occupied = \(bookings\.data \|\| \[\]\)/);
  assert.match(memberUi, /button\.disabled = !slot\.available/);
  assert.match(groupSlots, /\.like\("request_id", "PHONE-%"\)/);
  assert.match(groupSlots, /const phoneOverlap = phoneOccupied\.some/);
  assert.match(groupSlots, /available: !primaryOverlap && !assignmentOverlap && !phoneOverlap && !passed/);
});

test('AC-004: browser source stays syntactically valid', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(root, 'admin/booking-panel-core.js')]));
});
