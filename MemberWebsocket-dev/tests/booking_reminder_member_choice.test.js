const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('AC-001/002: member booking offers an optional LINE reminder with previous-day time', () => {
  const html = read('booking/index.html');
  const app = read('booking/app.js');
  assert.match(html, /id="bookingReminderEnabled" type="checkbox"/);
  assert.match(html, /id="bookingReminderTime" type="time" step="60" value="18:00" disabled/);
  assert.match(html, /bookingReminderConfirmSummary/);
  assert.match(app, /bookingReminderTime\.disabled = !els\.bookingReminderEnabled\.checked/);
  assert.match(app, /function reminderError\(\)/);
  assert.match(app, /currentServerTimeMs\(\)/);
  assert.match(app, /\.\.\.reminderPreference\(\)/);
  assert.match(app, /bookingReminderEnabled\.checked = booking\.reminderEnabled === true/);
  assert.match(app, /reminderTime \|\| '18:00'/);
});

test('AC-003: reminder configuration is retired from merchant shared booking settings', () => {
  const admin = read('admin/booking-panel-core.js');
  const api = read('supabase/functions/booking-admin-api/index.ts');
  assert.doesNotMatch(admin, /bookingAdminReminderEnabled|bookingAdminReminderTime|bookingAdminReminderHeading/);
  assert.doesNotMatch(admin, /reminderEnabled: els|reminderTime,/);
  assert.match(api, /legacyReminder\.data\.reminder_enabled/);
  assert.match(api, /legacyReminder\.data\.reminder_time/);
});

test('AC-004/005: every member booking route writes consent in same SQL transaction', () => {
  const api = read('supabase/functions/booking-api/index.ts');
  const contact = read('supabase/functions/booking-contact-api/index.ts');
  const group = read('supabase/functions/booking-group-api/index.ts');
  const sql = read('supabase/migrations/20261031090000_member_booking_reminder_choice.sql');
  for (const [code, name] of [
    [api,'create_booking_bundle_with_benefits_reminder'],
    [api,'update_booking_bundle_with_benefits_reminder'],
    [contact,'create_booking_bundle_with_contact_reminder'],
    [contact,'update_booking_bundle_with_contact_reminder'],
    [group,'create_group_booking_with_benefits_reminder_v2'],
    [group,'update_group_booking_with_benefits_reminder_v2'],
    [group,'create_friend_booking_with_reminder'],
  ]) {
    assert.ok(code.includes(name), `API must call ${name}`);
    assert.ok(sql.includes('function public.' + name), `migration must install ${name}`);
  }
  for (const code of [api,contact,group]) {
    assert.match(code,/INVALID_BOOKING_REMINDER/);
    assert.match(code,/p_reminder_enabled/);
    assert.match(code,/p_reminder_time/);
  }
  for (const code of [api,read('supabase/functions/booking-contact-api/booking.ts'),group]) {
    assert.match(code,/REMINDER_TIME_PASSED/);
  }
  assert.match(sql,/BOOKING_REMINDER_OWNER_MISMATCH/);
  assert.match(sql,/REQUEST_ID_CONFLICT/);
  assert.match(sql,/pg_advisory_xact_lock/);
});

test('AC-006/007: dispatch only stages opted-in confirmed bookings and checks again before sending', () => {
  const sql = read('supabase/migrations/20261031090000_member_booking_reminder_choice.sql');
  assert.match(sql,/b\.reminder_enabled and b\.status = 'confirmed'/);
  assert.match(sql,/b\.start_at::date = v_today \+ 1/);
  assert.match(sql,/b\.reminder_time\) at time zone 'Asia\/Taipei'/);
  assert.match(sql,/not b\.reminder_enabled or b\.status <> 'confirmed'/);
  assert.match(sql,/b\.cancellation_requested_at is null/);
  assert.match(sql,/m\.is_test_account is not true/);
  assert.match(sql,/create or replace function public\.skip_invalid_booking_reminder/);
  assert.match(sql,/v_start = v_job\.reminder_start_at/);
  const dispatchDefinition = sql.slice(sql.indexOf('create or replace function booking_notifications.sync_day_before_reminders()'));
  assert.doesNotMatch(dispatchDefinition,/s\.reminder_enabled|v_settings\.reminder_time/);
});

test('AC-008/009: existing confirmed bookings preserve prior policy, new appointments default to off', () => {
  const sql = read('supabase/migrations/20261031090000_member_booking_reminder_choice.sql');
  assert.match(sql,/add column reminder_enabled boolean not null default false/);
  assert.match(sql,/add column reminder_time time without time zone not null default time '18:00'/);
  assert.match(sql,/set reminder_enabled = s\.reminder_enabled/);
  assert.match(sql,/b\.status = 'confirmed'/);
  assert.match(sql,/check \(extract\(second from reminder_time\) = 0\)/);
});

test('AC-010/011: admin reservation summary reflects member LINE reminder safely', () => {
  const admin = read('admin/booking-panel-core.js');
  const api = read('supabase/functions/booking-api/index.ts');
  const loader = read('admin/booking-panel.js');
  const vm = require('node:vm');
  const helper = admin.match(/  function bookingReminderSummary\(booking\) \{[\s\S]*?\n  \}/);
  assert.ok(helper, 'admin should define a reminder presentation helper');
  const describe = vm.runInNewContext('(' + helper[0].trim() + ')');
  assert.equal(describe({ reminderEnabled: true, reminderTime: '09:30' }), '已設定｜預約前一天 09:30（台灣時間）');
  assert.equal(describe({ reminderEnabled: true, reminderTime: '18:00' }), '已設定｜預約前一天 18:00（台灣時間）');
  assert.equal(describe({ reminderEnabled: false, reminderTime: '18:00' }), '未設定');
  assert.equal(describe({}), '資料未同步');
  assert.equal(describe({ reminderEnabled: true, reminderTime: '25:99' }), '已設定｜提醒時間未取得');
  assert.equal(describe({ reminderEnabled: true, reminderTime: '<script>' }), '已設定｜提醒時間未取得');

  const render = admin.slice(admin.indexOf('function renderBookingSummary('), admin.indexOf('function summaryMetaItem('));
  assert.match(render, /summaryMetaItem\('LINE 預約提醒', bookingReminderSummary\(booking\)\)/);
  assert.match(render, /if \(isPhoneBooking\(booking\)\) \{[\s\S]*?\} else \{[\s\S]*?LINE 預約提醒/);
  assert.match(api, /reminderEnabled: row\.reminder_enabled === true/);
  assert.match(api, /reminderTime: String\(row\.reminder_time/);
  assert.match(loader, /member-reminder-20261125-1/);
});
