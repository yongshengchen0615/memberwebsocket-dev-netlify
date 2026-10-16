const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'supabase/functions/booking-cancellation-api/index.ts'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'admin/booking-cancellation-sync.js'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'admin/booking-panel.js'), 'utf8');

test('admin cancellation list returns contact and per-participant booking details', () => {
  assert.match(api, /contact_surname,contact_salutation,contact_phone/);
  assert.match(api, /members!bookings_member_id_fkey\(display_name,member_code,surname,salutation,phone\)/);
  assert.match(api, /from\("booking_participants"\)/);
  assert.match(api, /from\("booking_participant_items"\)/);
  assert.match(api, /technicianName:/);
  assert.match(api, /contactSurname,/);
  assert.match(api, /contactSalutation,/);
  assert.match(api, /contactPhone,/);
  assert.match(api, /participants,/);
  assert.match(api, /totalAmount,/);
});

test('admin cancellation request card uses the normalized booking format', () => {
  assert.match(ui, /summaryMetaItem\('LINE 名稱'/);
  assert.match(ui, /summaryMetaItem\('會員編號'/);
  assert.match(ui, /summaryMetaItem\('總服務時間'/);
  assert.match(ui, /summaryMetaItem\('總金額'/);
  assert.match(ui, /bookingContactName\(row\)/);
  assert.match(ui, /電話：\$\{String\(row\.contactPhone/);
  assert.match(ui, /appendParticipants\(summary, row\.participants/);
  assert.match(ui, /預約項目：\$\{participantItemsLabel/);
  assert.match(ui, /預約技師：/);
  assert.match(ui, /return `\$\{month\}\/\$\{day\}（\$\{weekday\}）`/);
  assert.match(loader, /booking-technician-disable-action-20260920-1/);
  assert.match(ui, /booking-admin-booking booking-summary-normalized/);
  assert.match(ui, /booking-admin-booking-heading/);
  assert.match(ui, /booking-received-summary/);
  assert.match(ui, /booking-member-meta/);
  assert.match(ui, /booking-admin-actions/);
  assert.match(ui, /booking-copy-button/);
  assert.doesNotMatch(ui, /booking-cancellation-card/);
  assert.doesNotMatch(ui, /background:#fffaf5/);
});
