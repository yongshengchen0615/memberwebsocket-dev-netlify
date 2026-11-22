const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const moduleUrl = pathToFileURL(path.join(root, 'supabase/functions/booking-line-notifications/pending-details.mjs')).href;
const source = fs.readFileSync(path.join(root, 'supabase/functions/booking-line-notifications/index.ts'), 'utf8');

function mockDb(rows, errors = {}) {
  const calls = [];
  const db = {
    from(table) {
      const call = { table };
      calls.push(call);
      return {
        select(fields) { call.fields = fields; return this; },
        eq(key, value) { call[key] = value; return this; },
        in(key, value) { call[key] = value; return this; },
        order() {
          return Promise.resolve({ data: rows[table] || [], error: errors[table] || null });
        },
      };
    },
  };
  return { db, calls };
}

const service = (participant_id, service_title, quantity, minutes, amount) => ({
  participant_id, service_id: '00000000-0000-4000-8000-000000000020',
  service_title, quantity, unit_duration_minutes: minutes, unit_price_amount: amount,
});

test('AC-001: official pending LINE includes every participant, services, totals, technician and notes', async () => {
  const { loadMemberPendingBookingDetails } = await import(moduleUrl);
  const { db, calls } = mockDb({
    booking_participants: [
      { id: 'p1', position: 1, member_note: '希望靠窗', booking_technicians: { name: '10技師' } },
      { id: 'p2', position: 2, member_note: '', booking_technicians: { name: '12技師' } },
    ],
    booking_items: [{
      service_id: '00000000-0000-4000-8000-000000000010',
      service_title: '到店準備', quantity: 1, unit_duration_minutes: 10, unit_price_amount: 0,
    }],
    booking_participant_items: [
      service('p1', '身體30', 2, 30, 800),
      service('p2', '腳底45', 1, 45, 900),
    ],
  });
  const message = await loadMemberPendingBookingDetails(db, 'booking-A');
  assert.match(message, /第一位預約\n預約項目：身體30 × 2\n個別時間：70 分鐘\n個別金額：NT\$1,600\n預約技師：10技師\n個別備註：希望靠窗/);
  assert.match(message, /第二位預約\n預約項目：腳底45\n個別時間：55 分鐘\n個別金額：NT\$900\n預約技師：12技師/);
  assert.doesNotMatch(message, /到店準備|預約編號|管理端說明/);
  assert.ok(calls.every(call => call.booking_id === 'booking-A' || call.table === 'booking_participant_items'));
  assert.deepEqual(calls.find(call => call.table === 'booking_participant_items').participant_id, ['p1', 'p2']);
});

test('AC-002: legacy single-person booking uses booking_items without requiring participants', async () => {
  const { loadMemberPendingBookingDetails } = await import(moduleUrl);
  const { db, calls } = mockDb({
    booking_participants: [],
    booking_items: [service(null, '身體60', 1, 60, 1200)],
  });
  const message = await loadMemberPendingBookingDetails(db, 'legacy-booking');
  assert.match(message, /第一位預約/);
  assert.match(message, /預約項目：身體60/);
  assert.match(message, /預約技師：現場安排/);
  assert.equal(calls.length, 2, 'legacy path must not query empty participant IDs');
});

test('AC-003: unavailable or incomplete booking details fail closed rather than push partial LINE', async () => {
  const { loadMemberPendingBookingDetails } = await import(moduleUrl);
  const missing = mockDb({ booking_participants: [{ id: 'p1', position: 1 }], booking_items: [], booking_participant_items: [] });
  await assert.rejects(loadMemberPendingBookingDetails(missing.db, 'booking-A'), /PENDING_BOOKING_SERVICES_UNAVAILABLE/);
  const failed = mockDb({ booking_participants: [], booking_items: [] }, { booking_items: new Error('synthetic network failure') });
  await assert.rejects(loadMemberPendingBookingDetails(failed.db, 'booking-A'), /PENDING_BOOKING_DETAILS_UNAVAILABLE/);
});

test('AC-004: untrusted service and note newlines cannot inject fake LINE fields', async () => {
  const { loadMemberPendingBookingDetails } = await import(moduleUrl);
  const { db } = mockDb({
    booking_participants: [{ id: 'p1', position: 1, member_note: '你好\n預約技師：惡意指定', booking_technicians: { name: '原技師' } }],
    booking_items: [],
    booking_participant_items: [service('p1', '按摩\n個別金額：NT$0', 1, 30, 500)],
  });
  const message = await loadMemberPendingBookingDetails(db, 'booking-A');
  assert.match(message, /預約項目：按摩 個別金額：NT\$0/);
  assert.match(message, /個別備註：你好 預約技師：惡意指定/);
  assert.equal((message.match(/^預約技師：/gm) || []).length, 1);
  assert.equal((message.match(/^個別金額：/gm) || []).length, 1);
});

test('AC-005: worker enforces member owner, pending status, and safe retry before any enriched push', () => {
  assert.match(source, /endsWith\(':created:member'\)/);
  assert.match(source, /pending\.data\?\.status !== 'pending'/);
  assert.match(source, /member\?\.line_user_id !== job\.recipient/);
  assert.match(source, /member\?\.status !== 'active'/);
  assert.match(source, /BOOKING_RECIPIENT_UNAUTHORIZED/);
  assert.match(source, /await loadMemberPendingBookingDetails\(db, job\.booking_id\)/);
  assert.match(source, /memberPendingDetails[\s\S]*?message_text: \x60\$\{job\.message_text\}/);
  assert.match(source, /Leave the claimed job retryable instead of sending a partial notice/);
});
