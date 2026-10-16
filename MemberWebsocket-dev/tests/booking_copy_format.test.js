const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('participant-aware booking copy formatter is valid and wired', () => {
  const source = fs.readFileSync(path.join(root, 'booking-copy-format.js'), 'utf8');
  const loader = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');

  assert.doesNotThrow(() => new Function(source));
  assert.match(loader, /booking-copy-format\.js/);
  assert.match(source, /booking-group-details-api/);
  const vm = require('node:vm'), context = {};
  vm.runInNewContext(fs.readFileSync(path.join(root,'booking-copy-text.js'),'utf8'),context);
  assert.match(source,/window\.BookingCopyText\.format/);
  assert.equal(context.BookingCopyText.format({bookingDate:'2026-10-14',startTime:'10:00',endTime:'11:00',name:'王先生',phone:'0912-345-678',partySize:1,participants:[{items:[{serviceTitle:'肩頸',quantity:2}],technicianName:'甲（主要技師）'}]}),
    '營業日 2026-10-14｜10:00–11:00\n王先生\n電話：0912345678\n預約人數：1 位\n\n第一位預約\n預約項目：肩頸 × 2\n預約技師：甲');
});

test('LINE notification enablement is committed as a migration', () => {
  const migration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260917151950_enable_booking_line_notifications.sql'),
    'utf8',
  );
  assert.match(migration, /update booking_notifications\.config/);
  assert.match(migration, /set enabled = true/);
});


test('booking notifications use participant details and profile contact fallback', () => {
  const migration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260918101500_booking_participant_notification_details.sql'),
    'utf8',
  );
  const contactApi = fs.readFileSync(
    path.join(root, 'supabase/functions/booking-contact-api/booking.ts'),
    'utf8',
  );
  const delivery = fs.readFileSync(
    path.join(root, 'supabase/functions/booking-line-notifications/delivery.ts'),
    'utf8',
  );

  assert.match(migration, /booking_participants/);
  assert.match(migration, /booking_participant_items/);
  assert.match(migration, /預約技師：/);
  assert.match(migration, /member_record\.surname/);
  assert.doesNotMatch(migration, /member_record\.display_name/);
  assert.match(contactApi, /members!bookings_member_id_fkey\(surname,salutation,phone\)/);
  assert.match(contactApi, /source === "member"/);
  assert.match(delivery, /participantsCard/);
  assert.match(delivery, /每位預約明細/);
});
