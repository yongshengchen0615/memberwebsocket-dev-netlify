const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
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
  assert.match(source,/window\.BookingCopyText\.formatClipboard/);
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

test('clipboard copy shows labeled date, start time and contact without end time', () => {
  const vm = require('node:vm'), context = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'booking-copy-text.js'), 'utf8'), context);
  const booking = {
    bookingDate: '2026-10-30', startTime: '11:30', endTime: '12:40',
    name: 'Chen先生', phone: '+886912345678', partySize: 1,
    participants: [{ items: [{ serviceTitle: 'a11', quantity: 1 }], technicianName: '10技師' }],
  };
  assert.equal(context.BookingCopyText.formatClipboard(booking), [
    '日期：2026-10-30',
    '時間：11:30',
    '預約人：Chen先生',
    '電話：+886912345678',
    '預約人數：1 位',
    '第一位預約',
    '預約項目：a11',
    '預約技師：10技師',
  ].join('\n'));
  assert.match(context.BookingCopyText.format(booking), /^營業日 2026-10-30｜11:30–12:40/);
});

test('clipboard and LINE formats keep optional notes attached to the correct participant', () => {
  const vm = require('node:vm'), context = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'booking-copy-text.js'), 'utf8'), context);
  const payload = {
    bookingDate: '2026-11-09', startTime:'09:00', endTime:'10:00',
    name:'王先生', phone:'0900123456', partySize:2,
    participants:[
      {items:[{serviceTitle:'肩頸'}],technicianName:'甲',memberNote:'怕冷，請加毯'},
      {items:[{serviceTitle:'腳底'}],technicianName:'乙',memberNote:'力道輕一點'},
    ],
    adminNote:'櫃檯已確認',
  };
  const copy = context.BookingCopyText.formatClipboard(payload);
  const first = copy.indexOf('第一位預約'), second = copy.indexOf('第二位預約');
  assert.ok(first > 0 && second > first);
  assert.ok(copy.indexOf('個別備註：怕冷，請加毯') > first);
  assert.ok(copy.indexOf('個別備註：怕冷，請加毯') < second);
  assert.ok(copy.indexOf('個別備註：力道輕一點') > second);
  assert.ok(copy.endsWith('管理端說明：櫃檯已確認'));
  assert.match(context.BookingCopyText.format(payload), /第二位預約[\\s\\S]*個別備註：力道輕一點/);
  const empty = context.BookingCopyText.formatClipboard({ ...payload, participants:payload.participants.map(p=>({...p,memberNote:''})), adminNote:'' });
  assert.doesNotMatch(empty,/個別備註：|管理端說明：/);
});
