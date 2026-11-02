const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const booking = {
  start_at: '2026-12-12T11:30:00', end_at: '2026-12-12T12:40:00',
  booking_date: '2026-12-12', contact_surname: '陳', contact_salutation: 'mr',
  contact_phone: '0912345678', party_size: 2, technician_id: null,
};
const member = { surname: '張', salutation: 'ms', phone: '0900000000' };

test('AC-RM-001: admin edits only merchant reminder prose, not member reminder time', () => {
  const ui = read('admin/booking-panel-core.js');
  const api = read('supabase/functions/booking-admin-api/index.ts');
  const migration = read('supabase/migrations/20261102210000_booking_reminder_message_template.sql');
  assert.match(ui, /id="bookingAdminReminderMessage"/);
  assert.match(ui, /id="bookingAdminReminderMessageForm"/);
  assert.match(ui, /id="bookingAdminReminderMessagePreview"/);
  assert.match(ui, /admin\.booking\.reminder-message\.save/);
  assert.doesNotMatch(ui, /bookingAdminReminderEnabled|bookingAdminReminderTime/);
  assert.match(api, /async function reminderMessageSave/);
  assert.match(api, /await authorizeAdmin\(supabase, identity\)/);
  assert.match(api, /await consumeRateLimit\(supabase, identity/);
  assert.match(api, /eq\('updated_at', expectedUpdatedAt\)/);
  assert.match(api, /BOOKING_REMINDER_MESSAGE_UPDATED/);
  assert.match(api, /reminderMessage: String\(row\?\.reminder_message/);
  assert.match(migration, /ALTER TABLE public\.booking_settings/);
  assert.match(migration, /platform_private\.tenants/);
  assert.match(migration, /char_length\(reminder_message\) BETWEEN 1 AND 400/);
  assert.match(api, /INVALID_REMINDER_MESSAGE/);
});

test('AC-RM-002: confirmation-like reminder has current contact, dates, participants, services, amounts and technicians', async () => {
  const module = await import(pathToFileURL(path.join(root, 'supabase/functions/booking-line-notifications/reminder-message.mjs')).href);
  const text = module.formatBookingReminderMessage({
    booking, member, reminderText: '請提前十分鐘抵達。\n無法出席請來電。',
    bookingItems: [{service_id: '00000000-0000-4000-8000-000000000010',unit_duration_minutes:10,quantity:1}],
    participants: [
      {id:'p2',position:2,technician_id:'t2'},
      {id:'p1',position:1,technician_id:'t1'},
    ],
    participantItems: [
      {participant_id:'p1',service_title:'服務 A',unit_duration_minutes:40,unit_price_amount:850,quantity:1},
      {participant_id:'p2',service_title:'服務 B',unit_duration_minutes:25,unit_price_amount:300,quantity:2},
    ],
    technicians:[{id:'t1',name:'甲技師'},{id:'t2',name:'乙技師'}],
  });
  assert.match(text, /^【預約提醒】\n提醒事項：請提前十分鐘抵達。\n提醒事項：無法出席請來電。/);
  for (const field of ['預約人：陳先生','營業日：2026/12/12','時段：2026/12/12 11:30–2026/12/12 12:40（台北時間）','電話：0912345678','預約人數：2 位','第一位預約','第二位預約','預約項目：服務 A','預約項目：服務 B × 2','個別金額：NT$850','個別金額：NT$600','預約技師：甲技師','預約技師：乙技師']) {
    assert.ok(text.includes(field), field);
  }
  assert.ok(text.indexOf('第一位預約') < text.indexOf('第二位預約'));
});

test('AC-RM-003: older single-person bookings and missing technician use safe fallback', async () => {
  const { formatBookingReminderMessage } = await import(pathToFileURL(path.join(root, 'supabase/functions/booking-line-notifications/reminder-message.mjs')).href);
  const text = formatBookingReminderMessage({ booking: {...booking,contact_surname:'',contact_salutation:'',party_size:1}, member,
    bookingItems:[{service_id:'s1',service_title:'修剪',unit_duration_minutes:45,unit_price_amount:600,quantity:1}],
  });
  assert.match(text,/預約人：張小姐/);
  assert.match(text,/第一位預約/);
  assert.match(text,/預約項目：修剪/);
  assert.match(text,/預約技師：現場安排/);
  assert.throws(() => formatBookingReminderMessage({booking:{},member}),/REMINDER_BOOKING_SCHEDULE_MISSING/);
});

test('AC-RM-004: dispatch rechecks opt-in, reads tenant data and never trusts outbox stale message', () => {
  const dispatch = read('supabase/functions/booking-line-notifications/index.ts');
  const loader = read('supabase/functions/booking-line-notifications/reminder.ts');
  const delivery = read('supabase/functions/booking-line-notifications/delivery.ts');
  assert.match(dispatch,/skip_invalid_booking_reminder/);
  assert.match(dispatch,/loadBookingReminderMessage\(db, job\.booking_id\)/);
  assert.match(dispatch,/message_text: await loadBookingReminderMessage/);
  assert.match(loader,/booking\.status !== 'confirmed'/);
  assert.match(loader,/booking\.reminder_enabled !== true/);
  assert.match(loader,/member\.is_test_account === true/);
  assert.match(loader,/\.from\('booking_participant_items'\)/);
  assert.match(loader,/\.from\('booking_settings'\).*select\('reminder_message'\)/);
  assert.match(delivery,/'預約提醒': \{ color:/);
  assert.match(delivery,/memberConfirmation \|\| memberReminder/);
  assert.match(delivery,/memberReminder && details/);
});
