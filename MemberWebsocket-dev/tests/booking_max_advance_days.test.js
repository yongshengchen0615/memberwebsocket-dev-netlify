const fs = require('node:fs');
const assert = require('node:assert/strict');

const read = (path) => fs.readFileSync(path, 'utf8');

const adminCore = read('MemberWebsocket-dev/admin/booking-panel-core.js');
const bookingApp = read('MemberWebsocket-dev/booking/app.js');
const calendarFlow = read('MemberWebsocket-dev/booking/calendar-flow.js');
const groupBooking = read('MemberWebsocket-dev/booking/group-booking.js');
const adminApi = read('MemberWebsocket-dev/supabase/functions/booking-admin-api/index.ts');
const bookingApi = read('MemberWebsocket-dev/supabase/functions/booking-api/index.ts');
const calendarApi = read('MemberWebsocket-dev/supabase/functions/booking-calendar-api/index.ts');
const groupApi = read('MemberWebsocket-dev/supabase/functions/booking-group-api/index.ts');
const groupSlotsApi = read('MemberWebsocket-dev/supabase/functions/booking-group-slots-api/index.ts');
const migration = read('MemberWebsocket-dev/supabase/migrations/20260919003500_booking_max_advance_days.sql');

assert.match(adminCore, /bookingAdminMaxAdvanceDays/);
assert.match(adminCore, /最多可預約幾天內/);
assert.match(adminCore, /maxAdvanceDays > 0 && maxAdvanceDays < minAdvanceDays/);
assert.match(adminCore, /maxAdvanceDays,/);

assert.match(bookingApp, /function globalMaximumDate\(\)/);
assert.match(bookingApp, /els\.bookingDate\.max = maximumDate/);
assert.match(bookingApp, /bookingDate > maximumDate/);
assert.match(bookingApp, /最遠可預約/);
assert.match(groupBooking, /maximumDate/);
assert.match(groupBooking, /最遠可預約/);

assert.match(calendarFlow, /maxAdvanceDays: 0/);
assert.match(calendarFlow, /maximumDate: ''/);
assert.match(calendarFlow, /date > maximumDate/);
assert.match(calendarFlow, /超過可預約範圍/);
assert.match(calendarFlow, /latestBookingDate/);

assert.match(adminApi, /maxAdvanceDays: Number\(row\?\.max_advance_days \|\| 0\)/);
assert.match(adminApi, /p_max_advance_days: maxAdvanceDays/);
assert.match(bookingApi, /BOOKING_TOO_FAR/);
assert.match(bookingApi, /assertBookingDateWindow/);
assert.match(bookingApi, /latestBookingDate/);
assert.match(calendarApi, /max_advance_days/);
assert.match(calendarApi, /latestBookingDate/);
assert.match(groupApi, /BOOKING_TOO_FAR/);
assert.match(groupApi, /assertBookingDateWindow/);
assert.match(groupSlotsApi, /max_advance_days/);
assert.match(groupSlotsApi, /latestDate/);

assert.match(migration, /add column if not exists max_advance_days integer not null default 0/);
assert.match(migration, /max_advance_days = 0 or max_advance_days >= min_advance_days/);
assert.match(migration, /p_max_advance_days integer/);
assert.match(migration, /BOOKING_TOO_FAR/);
assert.match(migration, /create trigger booking_enforce_advance_window/);
assert.match(migration, /new\.booking_date > v_today \+ v_settings\.max_advance_days/);

console.log('booking max advance days wiring OK');
