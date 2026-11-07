const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const read=path=>fs.readFileSync('MemberWebsocket-dev/'+path,'utf8');
const admin=read('admin/booking-panel-core.js');
const calendar=read('booking/calendar-flow.js');
const html=read('booking/index.html');
const adminApi=read('supabase/functions/booking-admin-api/index.ts');
const memberApi=read('supabase/functions/booking-api/index.ts');
const monthApi=read('supabase/functions/booking-calendar-api/index.ts');
const migration=read('supabase/migrations/20261107093000_booking_phone_fallback.sql');
const safeFunction=calendar.match(/  function safePhoneBookingNumber\(value\) \{[\s\S]*?\n  \}/);
assert.ok(safeFunction);
const validate=vm.runInNewContext(safeFunction[0]+'\nsafePhoneBookingNumber');

test('AC-001 validates merchant phone before presenting a dial link',()=>{
  for(const number of ['06-1234567','0912345678','+886-6-1234567','06 (2) 1234567']) assert.equal(validate(number),number);
  for(const number of ['','12345','1'.repeat(16),'tel:0912345678','javascript:alert(1)','09/12345678','09\n12345678','(06) 1234567']) assert.equal(validate(number),'',number);
});
test('AC-002 admin phone is part of draft detection, validation, save, readback',()=>{
  assert.match(admin,/id="bookingAdminPhoneNumber" type="tel"/);
  assert.match(admin,/SETTINGS_INPUT_IDS = \[[^\n]*'bookingAdminPhoneNumber'/);
  assert.match(admin,/bookingAdminPhoneNumber\.value = String\(settings\.phoneBookingNumber \|\| ''\)/);
  assert.match(admin,/phoneBookingNumber,/);
  assert.match(admin,/INVALID_PHONE_BOOKING_NUMBER|店家電話格式錯誤/);
  assert.match(adminApi,/phoneBookingNumber: String\(row\?\.phone_booking_number \|\| ""\)/);
  assert.match(adminApi,/save_booking_shared_settings_v8/);
  assert.match(adminApi,/p_phone_booking_number: phoneBookingNumber/);
});
test('AC-003 both member bootstrap and calendar month return the shop telephone number',()=>{
  assert.match(memberApi,/phoneBookingNumber: String\(row\?\.phone_booking_number \|\| ""\)/);
  assert.match(monthApi,/booking_notice,work_start_time,work_end_time,phone_booking_number/);
  assert.match(monthApi,/phoneBookingNumber: String\(settingsResult\.data\.phone_booking_number \|\| ""\)/);
  assert.match(calendar,/detail\.settings\?\.phoneBookingNumber !== undefined/);
});
test('AC-004 day modal exposes dial control only when outside min or max advance day window',()=>{
  assert.match(calendar,/date < state\.minimumDate \|\| \(state\.maximumDate && date > state\.maximumDate\)/);
  assert.match(calendar,/date >= state\.today/);
  assert.match(calendar,/!state\.holidaysByDate\.has\(date\)/);
  assert.match(calendar,/els\.bookingPhoneFallback\.hidden = !phoneAllowed/);
  assert.match(calendar,/els\.bookingPhoneDial\.href = `tel:\$\{phone\.replace/);
  assert.match(html,/id="bookingPhoneFallback"[^>]*hidden/);
  assert.match(html,/不會自動建立線上預約紀錄/);
  assert.match(calendar,/if \(els\.startDayBookingButton\) els\.startDayBookingButton\.disabled = Boolean\(reason\)/);
  assert.match(calendar,/button\.addEventListener\('click', \(\) => openDayModal\(date, button\)\)/);
});
test('AC-005 migration retains legacy RPC and changes new settings atomically with restricted access',()=>{
  assert.match(migration,/phone_booking_number text not null default ''/);
  assert.match(migration,/save_booking_shared_settings_v8/);
  assert.match(migration,/for update/);
  assert.match(migration,/public\.save_booking_shared_settings_v7\(/);
  assert.match(migration,/set phone_booking_number = v_phone/);
  assert.match(migration,/PHONE_BOOKING_NUMBER_UPDATED/);
  assert.match(migration,/if p_phone_booking_number is null then v_phone := v_original; end if/);
  assert.match(adminApi,/body\.phoneBookingNumber === undefined \? null/);
  assert.match(migration,/revoke all on function public\.save_booking_shared_settings_v8/);
  assert.match(migration,/to service_role/);
});
