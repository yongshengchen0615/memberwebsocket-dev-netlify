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
  // v10 delegates through v9 and v8, preserving phone authorization and validation.
  assert.match(adminApi,/save_booking_shared_settings_v10/);
  assert.match(read('supabase/migrations/20261108210000_booking_end_overrun_minutes.sql'),/save_booking_shared_settings_v9\(/);
  assert.match(read('supabase/migrations/20261108173000_booking_allow_end_overrun.sql'),/save_booking_shared_settings_v8\(/);
  assert.match(adminApi,/p_phone_booking_number: phoneBookingNumber/);
});
test('AC-003 both member bootstrap and calendar month return the shop telephone number',()=>{
  assert.match(memberApi,/phoneBookingNumber: String\(row\?\.phone_booking_number \|\| ""\)/);
  assert.match(monthApi,/booking_notice,work_start_time,work_end_time,phone_booking_number/);
  assert.match(monthApi,/phoneBookingNumber: String\(settingsResult\.data\.phone_booking_number \|\| ""\)/);
  assert.match(calendar,/detail\.settings\?\.phoneBookingNumber !== undefined/);
});
test('AC-004 phone respects merchant horizon and holidays, not online-only lead time',()=>{
  assert.doesNotMatch(calendar,/calendar-phone-badge/);
  assert.match(calendar,/const phoneOnly = Boolean\(phoneAllowed && reason && date < state\.minimumDate\)/);
  assert.match(calendar,/els\.startDayBookingButton\.hidden = phoneOnly/);
  assert.match(calendar,/const phoneAllowed = Boolean\(phone && date && !phoneBookingBlockReason\(date\)\)/);
  assert.match(calendar,/if \(date < state\.minimumDate\) return/);
  assert.match(calendar,/if \(state\.maximumDate && date > state\.maximumDate\) return/);
  assert.match(calendar,/if \(date < state\.today\) return/);
  assert.match(calendar,/if \(holidays\.length\) return/);
  assert.match(calendar,/els\.bookingPhoneFallback\.hidden = !phoneAllowed/);
  assert.match(calendar,/els\.bookingPhoneDial\.href = `tel:\$\{phone\.replace/);
  assert.match(calendar,/else if \(els\.bookingPhoneDial\) \{\s*els\.bookingPhoneDial\.removeAttribute\('href'\)/);
  assert.match(calendar,/els\.startDayBookingButton\.disabled = Boolean\(reason\)/);
  assert.match(calendar,/button\.addEventListener\('click', \(\) => openDayModal\(date, button\)\)/);
  assert.match(html,/<button id="startDayBookingButton"[^>]*>線上預約<\/button>/);
  assert.match(html,/<div class="booking-day-footer">[\s\S]*?id="startDayBookingButton"[\s\S]*?id="bookingPhoneFallback"[^>]*hidden[\s\S]*?id="bookingPhoneDial"/);
  assert.match(html,/id="bookingPhoneDial" class="button button-dark button-wide"/);
  assert.doesNotMatch(html,/id="bookingPhoneFallbackTitle"|id="bookingPhoneFallbackNumber"/);
  assert.doesNotMatch(html,/此日期在商家設定的可預約範圍內|不會自動建立線上預約紀錄/);
  assert.match(calendar,/const dialLabel = `撥打店家電話：\$\{phone\}`/);
  assert.match(calendar,/els\.bookingPhoneDial\.textContent = dialLabel/);
  assert.match(calendar,/els\.bookingPhoneDial\.textContent = '撥打店家電話'/);
  assert.match(admin,/只有在商家可預約日期範圍內且非休假日/);
  assert.match(memberApi,/function assertBookingDateWindow\(/);
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
