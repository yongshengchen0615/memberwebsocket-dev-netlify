const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('member note is displayed, submitted and hydrated across booking flows', () => {
  const app = read('booking/app.js');
  const group = read('booking/group-booking.js');
  const bookingApi = read('supabase/functions/booking-api/index.ts');
  const groupApi = read('supabase/functions/booking-group-api/index.ts');
  const admin = read('admin/booking-panel-core.js');

  assert.ok(app.includes('memberNote: els.memberNote.value'));
  assert.ok(app.includes("els.memberNote.value = booking.memberNote || ''"));
  assert.ok(app.includes('備註：'));
  assert.ok(group.includes('participants'));

  assert.ok(bookingApi.includes('memberNote: row.member_note || ""'));
  assert.ok(bookingApi.includes('adminNote: row.admin_note || ""'));
  assert.ok(bookingApi.includes('p_member_note: memberNote'));
  assert.ok(groupApi.includes('memberNote:r.member_note||""'));
  assert.ok(groupApi.includes('adminNote:r.admin_note||""'));
  assert.ok(admin.includes('會員備註：'));
  assert.ok(admin.includes('管理端說明：'));
});

test('booking note columns are bounded and notification migration sends both note types', () => {
  const bookingApi = read('supabase/functions/booking-api/index.ts');
  const groupApi = read('supabase/functions/booking-group-api/index.ts');
  const migration = read('supabase/migrations/20260918140535_booking_notification_notes.sql');

  assert.ok(bookingApi.includes('asText(body.memberNote, 500)'));
  assert.ok(bookingApi.includes('asText(body.adminNote, 500)'));
  assert.ok(groupApi.includes('asText(body.memberNote,500)'));
  assert.ok(migration.includes('會員備註：'));
  assert.ok(migration.includes('管理端說明：'));
});

test('LINE Flex transport parses note labels as standard booking detail fields', () => {
  const delivery = read('supabase/functions/booking-line-notifications/delivery.ts');
  const deliveryTest = read('supabase/functions/booking-line-notifications/delivery_test.ts');

  assert.ok(delivery.includes("line.indexOf('：')"));
  assert.ok(delivery.includes('fields.push({ label, value })'));
  assert.ok(deliveryTest.includes('會員備註：希望加強肩頸'));
  assert.ok(deliveryTest.includes('管理端說明：已安排安靜區域'));
});

test('confirmation modal shows the note in the current single and group renderers', () => {
  const app = read('booking/app.js');
  const group = read('booking/group-booking.js');
  const html = read('booking/index.html');

  assert.ok(app.includes("noteBox.className = 'group-confirm-participant booking-confirm-note'"));
  assert.ok(app.includes("note.textContent = els.memberNote.value.trim() || '未填寫'"));
  assert.ok(group.includes("noteBox.className = 'group-confirm-participant booking-confirm-note'"));
  assert.ok(group.includes("getElementById('memberNote')"));
  assert.ok(group.includes("'未填寫'"));

  assert.ok(!html.includes('booking-confirm-details.js'));
  assert.ok(!html.includes('member-booking-format.js'));
});
