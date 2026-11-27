const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = (name) => fs.readFileSync('MemberWebsocket-dev/' + name, 'utf8');
const admin = read('admin/booking-panel-core.js');
const adminApi = read('supabase/functions/booking-admin-api/index.ts');
const calendarApi = read('supabase/functions/booking-calendar-api/index.ts');
const member = read('booking/calendar-flow.js');
const memberPage = read('booking/index.html');
const cardCss = read('booking/calendar-flow.css');
const calendarCss = read('booking/calendar-holiday-theme.css');
const migration = read('supabase/migrations/20261127045000_booking_holiday_notice.sql');

test('AC-HOL-001: admin edits holiday notice in the existing atomic messages form', () => {
  assert.match(admin, /id="bookingAdminHolidayNotice" maxlength="400"/);
  assert.match(admin, /id="bookingAdminHolidayNoticeCount"/);
  assert.match(admin, /holidayNotice: String\(els\.bookingAdminHolidayNotice\.value/);
  assert.match(admin, /manageRequest\('admin\.booking\.messages\.save'/);
  assert.match(admin, /state\.messagesDraftVersion/);
  assert.match(admin, /els\.bookingAdminHolidayNotice\.value = String\(settings\.holidayNotice/);
  assert.match(admin, /'bookingAdminHolidayNotice', 400/);
  assert.match(admin, /五項訊息一次儲存/);
});

test('AC-HOL-002: authorized API uses CAS, validates length, and preserves older clients', () => {
  const src = adminApi.slice(adminApi.indexOf('async function messagesSave('), adminApi.indexOf('async function settingsSave('));
  assert.match(src, /hasHolidayNotice = Object\.prototype\.hasOwnProperty\.call\(body, "holidayNotice"\)/);
  assert.match(src, /typeof body\.holidayNotice !== "string"/);
  assert.match(src, /holidayNotice\?\.length \?\? 0\) > 400/);
  assert.match(src, /\.\.\.\(hasHolidayNotice \? \{ holiday_notice: holidayNotice \} : \{\}\)/);
  assert.match(src, /\.eq\("id", 1\)\.eq\("updated_at", expectedUpdatedAt\)/);
  assert.match(src, /if \(!result\.data\) throw new ApiError\(409/);
  assert.match(src, /holidayNotice: result\.data\.holiday_notice/);
  assert.match(adminApi, /await authorizeAdmin\(supabase, identity\)/);
  assert.match(migration, /holiday_notice text not null default ''/);
  assert.match(migration, /char_length\(holiday_notice\) <= 400/);
});

function renderNotice(holidayNotice, title) {
  const start = member.indexOf('  function updateDayAction() {');
  const end = member.indexOf('\n  function renderPhoneServiceReference(', start);
  assert.ok(start >= 0 && end > start);
  const notice = { hidden: true, textContent: '' };
  const button = { disabled: false, hidden: false };
  const phone = { hidden: false };
  const state = {
    historyDate: '2026-12-12', holidaysByDate: new Map([['2026-12-12', [{ title }]]]),
    phoneBookingNumber: '', holidayNotice, minimumDate: '2026-11-01',
  };
  const els = {
    bookingDayHolidayNotice: notice, startDayBookingButton: button, bookingPhoneFallback: phone,
    bookingDayHolidayDetails: { hidden: true, replaceChildren() {} },
    bookingDayHint: { textContent: '' },
    bookingPhoneDial: { removeAttribute() {}, setAttribute() {} },
  };
  vm.runInNewContext(member.slice(start, end) + '\nupdateDayAction();', {
    state, els, bookingBlockReason: () => '休假日，無法預約',
    safePhoneBookingNumber: () => '', phoneBookingBlockReason: () => '休假日',
    renderPhoneServiceReference() {}, holidayDetails: () => [],
  });
  return { notice, button, phone };
}

test('AC-HOL-003: member displays plain text and hides booking actions on holidays', () => {
  const custom = '技師休假提醒：本日不接待。\n請另選日期 <script>alert(1)</script>';
  const result = renderNotice(custom, '技師休假');
  assert.equal(result.notice.textContent, custom);
  assert.equal(result.notice.hidden, false);
  assert.equal(result.button.hidden, true);
  assert.equal(result.button.disabled, true);
  assert.equal(result.phone.hidden, true);
  assert.match(calendarApi, /booking_notice,holiday_notice,work_start_time/);
  assert.match(calendarApi, /maxAdvanceDays, bookingNotice, holidayNotice, phoneBookingNumber/);
  assert.match(member, /typeof detail\.settings\?\.holidayNotice === 'string'/);
  assert.match(member, /state\.holidayNotice = '';/);
});

test('AC-HOL-004: empty notice uses the existing title-sensitive default', () => {
  assert.equal(renderNotice('', '技師休假').notice.textContent, '技師休假提醒：當日無法預約，請改選其他日期。');
  assert.equal(renderNotice('', '店休').notice.textContent, '休假提醒：當日無法預約，請改選其他日期。');
});

test('AC-HOL-005: light/dark high-contrast holiday styles and versioned assets', () => {
  assert.match(cardCss, /border: 2px solid #b6462f/);
  assert.match(cardCss, /white-space: pre-wrap/);
  assert.match(cardCss, /html\[data-theme="dark"\] \.booking-day-footer \.booking-day-holiday-notice/);
  assert.match(calendarCss, /html\[data-theme="dark"\] #calendarGrid \.calendar-day\.holiday-disabled/);
  assert.match(calendarCss, /background: #ffeddf/);
  assert.match(memberPage, /holiday-notice=20261127-1/);
  assert.match(memberPage, /holiday-contrast=20261127-1/);
});
