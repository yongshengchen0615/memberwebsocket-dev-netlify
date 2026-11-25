const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('AC-001 Taiwan mobile booking contacts display and save as local 09 numbers', () => {
  const file = path.join(root, 'booking/contact-phone.js');
  assert.equal(fs.existsSync(file), true, 'booking phone formatter must exist');
  const window = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window });
  const format = window.BookingContactPhone.format;
  assert.equal(typeof format, 'function');
  for (const input of ['+886912345678', '886912345678', '+886-912-345-678', '+886 (0)912-345-678', '0912-345-678', '0912345678']) {
    assert.equal(format(input), '0912345678', input);
  }
  for (const input of ['+819012345678', '+14155552671', '+886212345678', '02-12345678', '+8869112345678', '886', '', null]) {
    assert.equal(format(input), String(input || ''), String(input));
  }
});

test('AC-002 booking formatter loads before member contact and group booking scripts', () => {
  const html = read('booking/index.html');
  const formatter = html.indexOf('./contact-phone.js');
  const contact = html.indexOf('./contact-details.js');
  const group = html.indexOf('./group-booking.js');
  assert.ok(formatter !== -1 && formatter < contact && contact < group);
});

test('AC-003 member profile, custom booking, edits and group bookings use local phone formatter', () => {
  const contact = read('booking/contact-details.js');
  const group = read('booking/group-booking.js');
  assert.match(contact, /const phone = window\.BookingContactPhone\.format\(cachedProfile\.phone\)/);
  assert.match(contact, /contactPhone: window\.BookingContactPhone\.format\(phone\)/);
  assert.match(contact, /window\.BookingContactPhone\.format\(booking\.contactPhone/);
  assert.match(group, /contactPhone: window\.BookingContactPhone\.format\(/);
});

test('AC-004 booking APIs normalize Taiwan mobile on write and on read without changing other countries', () => {
  const common = read('supabase/functions/_shared/booking-contact-phone.ts');
  const contact = read('supabase/functions/booking-contact-api/booking.ts');
  const group = read('supabase/functions/booking-group-api/index.ts');
  assert.match(common, /export function formatBookingPhone/);
  assert.match(common, /886/);
  assert.match(contact, /formatBookingPhone\(asText\(body\.contactPhone/);
  assert.match(contact, /formatBookingPhone\(asText\(row\.contact_phone/);
  assert.match(contact, /formatBookingPhone\(asText\(member\.phone/);
  assert.match(group, /phone:formatBookingPhone\(asText\(body\.contactPhone/);
  assert.match(group, /contactPhone:formatBookingPhone\(r\.contact_phone/);
});
