const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = (path) => fs.readFileSync('MemberWebsocket-dev/' + path, 'utf8');
const calendar = read('booking/calendar-flow.js');
const calendarCss = read('booking/calendar-flow.css');
const admin = read('admin/booking-panel-core.js');
const adminApi = read('supabase/functions/booking-admin-api/index.ts');
const memberApi = read('supabase/functions/booking-api/index.ts');
const calendarApi = read('supabase/functions/booking-calendar-api/index.ts');
const migration = read('supabase/migrations/20261107093000_booking_phone_fallback.sql');

const validator = calendar.match(/  function validPhoneBookingNumber\(value\) \{[\s\S]*?\n  \}/);
assert.ok(validator, 'The calendar should validate merchant phone numbers before making tel links');
const validPhoneBookingNumber = vm.runInNewContext(validator[0] + '\nvalidPhoneBookingNumber');

test('telephone link only accepts sane 6-15 digit merchant contact numbers', () => {
  for (const valid of ['06-1234567', '02 2345 6789', '+886-6-1234567', '06 (2) 1234567', '0912345678']) {
    assert.equal(validPhoneBookingNumber(valid), valid);
  }
  for (const unsafe of ['', '12', '12345', '1'.repeat(16), 'tel:0912345678', '+886;ext=123', '09\n12345678', 'javascript:alert(1)', '09+12345678', '09/12345678', '(06) 1234567']) {
    assert.equal(validPhoneBookingNumber(unsafe), '', unsafe);
  }
});

test('admin settings persist the phone alongside existing shared booking rules', () => {
  assert.match(admin, /id="bookingAdminPhoneNumber" type="tel"/);
  assert.match(admin, /els\.bookingAdminPhoneNumber\.value = String\(settings\.phoneBookingNumber \|\| ''\)/);
  assert.match(admin, /phoneBookingNumber,/);
  assert.match(admin, /admin\.booking\.settings\.save/);
  assert.match(adminApi, /phoneBookingNumber: String\(row\?\.phone_booking_number \|\| ""\)/);
  assert.match(adminApi, /INVALID_PHONE_BOOKING_NUMBER/);
  assert.match(adminApi, /save_booking_shared_settings_v8/);
  assert.match(adminApi, /p_phone_booking_number: phoneBookingNumber/);
});

test('member and month endpoints both expose phone settings for calendar refresh', () => {
  assert.match(memberApi, /phoneBookingNumber: String\(row\?\.phone_booking_number \|\| ""\)/);
  assert.match(calendarApi, /min_advance_days,max_advance_days,booking_notice,work_start_time,work_end_time,phone_booking_number/);
  assert.match(calendarApi, /phoneBookingNumber: String\(settingsResult\.data\.phone_booking_number \|\| ""\)/);
  assert.match(calendar, /detail\.settings\?\.phoneBookingNumber !== undefined/);
});

test('future dates outside earliest or latest online dates offer a phone route without online booking', () => {
  assert.match(calendar, /isAdvanceBlocked = !isPast && date < minimumDate/);
  assert.match(calendar, /isRangeBlocked = Boolean\(maximumDate && date > maximumDate\)/);
  assert.match(calendar, /button\.disabled = isPast \|\| \(\(isAdvanceBlocked \|\| isRangeBlocked\) && !isHoliday && !state\.phoneBookingNumber\)/);
  assert.match(calendar, /if \(state\.phoneBookingNumber\) button\.addEventListener\('click', \(\) => showPhoneBooking\(date, reason, button\)\)/);
  assert.match(calendar, /if \(date < \(state\.minimumDate \|\| state\.today\) \|\| \(state\.maximumDate && date > state\.maximumDate\)\) return/);
  assert.match(calendar, /els\.phoneDial\.href = `tel:\$\{number\.replace\(\/\[ \(\)\-\]\/g, ''\)\}`/);
  assert.match(calendar, /!isHoliday && !isPast/);
  assert.match(calendarCss, /calendar-day\.advance-disabled\.phone-available/);
});

test('two-day advance setting means today and tomorrow are telephone-only, later dates stay online', () => {
  const today = '2026-11-07';
  const addDays = (days) => {
    const day = new Date(today + 'T00:00:00Z');
    day.setUTCDate(day.getUTCDate() + days);
    return day.toISOString().slice(0, 10);
  };
  const minimumDate = addDays(2);
  const maximumDate = addDays(30);
  assert.equal(minimumDate, '2026-11-09');
  assert.equal('2026-11-07' < minimumDate, true);
  assert.equal('2026-11-08' < minimumDate, true);
  assert.equal('2026-11-09' < minimumDate, false);
  assert.equal('2026-12-08' > maximumDate, true);
  assert.match(memberApi, /assertBookingDateWindow\(bookingDate, settings\)/);
  assert.match(memberApi, /BOOKING_TOO_EARLY/);
  assert.match(memberApi, /BOOKING_TOO_FAR/);
});

test('migration commits main settings and phone as a unit and limits RPC to service role', () => {
  assert.match(migration, /phone_booking_number text not null default ''/);
  assert.match(migration, /check \(/);
  assert.match(migration, /save_booking_shared_settings_v8/);
  assert.match(migration, /for update/);
  assert.match(migration, /public\.save_booking_shared_settings_v7\(/);
  assert.match(migration, /set phone_booking_number = v_phone/);
  assert.match(migration, /PHONE_BOOKING_NUMBER_UPDATED/);
  assert.match(migration, /revoke all on function public\.save_booking_shared_settings_v8/);
  assert.match(migration, /to service_role/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to anon/);
});
