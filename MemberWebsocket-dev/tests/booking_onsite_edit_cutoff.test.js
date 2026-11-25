const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const policy = require('../booking/onsite-edit-policy.js');
const member = read('booking/app.js');
const html = read('booking/index.html');
const groupUi = read('booking/group-booking.js');
const admin = read('admin/booking-panel-core.js');
const adminApi = read('supabase/functions/booking-admin-api/index.ts');
const memberApi = read('supabase/functions/booking-api/index.ts');
const groupApi = read('supabase/functions/booking-group-api/index.ts');
const migration = read('supabase/migrations/20261125110000_booking_onsite_edit_message.sql');
const now = Date.parse('2026-11-25T09:00:00+08:00');
const booking = { status:'confirmed', bookingDate:'2026-11-25', startAt:'2026-11-25T10:00:00+08:00', cancellationRequestedAt:null };

test('AC-001: earlier than current min-advance date must go onsite, even before appointment starts', () => {
  assert.equal(policy.canModifyOnline(booking, { minAdvanceDays:1 }, '2026-11-25', now), false);
  assert.equal(policy.canModifyOnline({ ...booking, bookingDate:'2026-11-26', startAt:'2026-11-26T10:00:00+08:00' }, { minAdvanceDays:1 }, '2026-11-25', now), true);
});
test('AC-002: min advance 0 allows still-upcoming same-day, but rejects elapsed appointment and invalid state', () => {
  assert.equal(policy.canModifyOnline(booking, { minAdvanceDays:0 }, '2026-11-25', now), true);
  assert.equal(policy.canModifyOnline(booking, { minAdvanceDays:0 }, '2026-11-25', Date.parse(booking.startAt)), false);
  assert.equal(policy.canModifyOnline({ ...booking, status:'rejected' }, { minAdvanceDays:0 }, '2026-11-25', now), false);
  assert.equal(policy.canModifyOnline({ ...booking, cancellationRequestedAt:'2026-11-24T09:00:00Z' }, { minAdvanceDays:0 }, '2026-11-25', now), false);
});
test('AC-002: cross-midnight booking uses the API business date rather than browser local date', () => {
  const overnight = { ...booking, bookingDate:'2026-11-25', startAt:'2026-11-26T01:00:00+08:00' };
  assert.equal(policy.canModifyOnline(overnight, { minAdvanceDays:0 }, '2026-11-25', now), true);
  assert.equal(policy.canModifyOnline(overnight, { minAdvanceDays:1 }, '2026-11-25', now), false);
});
test('AC-001: member renders onsite modification message instead of opening the edit form', () => {
  assert.match(html, /onsite-edit-policy\.js/);
  assert.match(member, /BookingOnsiteEditPolicy\.canModifyOnline/);
  assert.match(member, /editButton\.textContent = onlineEditAllowed \? '修改預約' : '現場修改'/);
  assert.match(member, /onsiteEditMessage/);
  assert.match(member, /BookingSystem\.showNotice\(onsiteEditMessage\(\)/);
  assert.match(member, /if \(state\.editing && !canEditOnline/);
  assert.match(groupUi, /booking:edit-online-blocked/);
});
test('AC-003: admin message is independently editable and saved atomically with CAS', () => {
  assert.match(admin, /id="bookingAdminOnsiteEditMessage"/);
  assert.match(admin, /onsiteEditMessage: String\(els\.bookingAdminOnsiteEditMessage\.value/);
  assert.match(adminApi, /onsiteEditMessage: String\(row\?\.onsite_edit_message/);
  assert.match(adminApi, /onsite_edit_message: onsiteEditMessage/);
  assert.match(adminApi, /\.eq\("id", 1\)\.eq\("updated_at", expectedUpdatedAt\)/);
  assert.match(adminApi, /INVALID_ONSITE_EDIT_MESSAGE/);
  assert.match(memberApi, /onsiteEditMessage: String\(row\?\.onsite_edit_message/);
});
test('AC-004: both single and group member updates reject cutoff before writing; normal create/admin unaffected', () => {
  assert.match(memberApi, /BOOKING_ONSITE_EDIT_REQUIRED/);
  assert.match(memberApi, /assertOriginalBookingOnlineEditable\(original\.data, settings\)/);
  assert.match(memberApi, /\.eq\("member_id", member\.id\)/);
  assert.match(groupApi, /BOOKING_ONSITE_EDIT_REQUIRED/);
  assert.match(groupApi, /\.eq\("member_id",m\.id\)/);
  assert.match(groupApi, /assertOriginalBookingOnlineEditable\(existing\.data,g\.cfg\)/);
});
test('AC-005: public and existing tenant booking settings plus provisioning blueprint carry guarded message', () => {
  assert.match(migration, /public\.booking_settings|v_schema='public'/);
  assert.match(migration, /platform_private\.tenants/);
  assert.match(migration, /platform_private\.business_templates/);
  assert.match(migration, /booking_settings/);
  assert.match(migration, /onsite_edit_message/);
  assert.match(migration, /booking_onsite_edit_message_length_check/);
});
