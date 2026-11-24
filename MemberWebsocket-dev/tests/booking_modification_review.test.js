const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');

const member = read('booking/app.js');
const api = read('supabase/functions/booking-api/index.ts');
const frontdesk = read('frontdesk/app.js');
const admin = read('admin/booking-panel-core.js');
const frontdeskBackend = read('supabase/functions/_shared/frontdesk-handler.mjs');
const worker = read('supabase/functions/booking-line-notifications/index.ts');
const delivery = read('supabase/functions/booking-line-notifications/delivery.ts');
const migration = read('supabase/migrations/20261124210000_member_booking_modification_pending_line.sql');

test('AC-MOD-001: extending a service into the next occupied slot warns and blocks the choice', () => {
  assert.match(api, /const overlap = occupied\.some\(/);
  assert.match(api, /available: !overlap && !passed/);
  assert.match(member, /totalDuration > original\.originalDurationMinutes/);
  assert.match(member, /original\.originalDate === els\.bookingDate\.value/);
  assert.match(member, /slot\.startTime === original\.originalStartTime && slot\.unavailableReason === 'occupied'/);
  assert.match(member, /服務總時長會影響後面預約，請修改為不會影響後面預約的時間。/);
  assert.match(member, /showConfirmMessage\(modifying \? '服務總時長會影響後面預約/);
  assert.match(api, /\["BOOKING_SLOT_TAKEN", 409/);
  assert.match(api, /raw\?\.code === "23P01"/);
});

test('AC-MOD-002: member sees pending review and cannot send a LINE notification from the browser', () => {
  assert.match(member, /等待櫃檯或管理端確認/);
  assert.match(member, /修改預約已送出/);
  assert.doesNotMatch(member, /sendBookingMemberChatMessage/);
  assert.match(migration, /event_kind = 'modified_by_member'/);
  assert.match(migration, /latest\.status = 'pending'/);
  assert.match(migration, /member_record\.status = 'active'/);
  assert.match(migration, /coalesce\(member_record\.is_test_account,false\) = false/);
  assert.match(migration, /狀態：等待櫃檯或管理端確認修改預約/);
  assert.match(migration, /'member',member_record\.line_user_id/);
  assert.match(migration, /NEW\.id::text \|\| ':member-modification-pending'/);
  assert.match(migration, /on conflict \(coalesce_key,channel,recipient\)/);
  assert.match(migration, /member_notice/);
  assert.match(worker, /endsWith\(':member-pending'\)/);
  assert.match(worker, /pending\.data\?\.status !== 'pending'/);
  assert.match(worker, /BOOKING_RECIPIENT_UNAUTHORIZED/);
  // The SQL modification notice already contains complete participant data.
  // Only a newly created booking needs its participants fetched after commit.
  assert.match(worker, /if \(String\(job\.event_key \|\| ''\)\.endsWith\(':created:member'\)\) \{\s*try \{\s*memberPendingDetails = await loadMemberPendingBookingDetails/);

});

test('AC-MOD-003: frontdesk update cards use the audited modification event rather than a creation title', () => {
  assert.match(delivery, /const frontdeskModification = job\.channel === 'frontdesk'/);
  assert.match(delivery, /String\(job\.event_key \|\| ''\)\.includes\(':modified:'\)/);
  assert.match(delivery, /const displayTitle = frontdeskModification \? '修改預約'/);
  assert.match(migration, /function_row->>'name' = 'notice_enqueue'/);
  assert.match(migration, /business_templates/);
  assert.match(migration, /for business in/);
  assert.match(migration, /booking_notifications\.enqueue\(\)/);
});

test('AC-MOD-004: existing approvals require authenticated admin or approved reviewing frontdesk', () => {
  assert.match(api, /await authorizeAdmin\(supabase, identity\)/);
  assert.match(api, /if \(action === "admin\.booking\.status\.update"\) return await adminStatusUpdate/);
  assert.match(api, /booking\.status === "pending"/);
  assert.match(frontdeskBackend, /frontdesk\.booking\.update/);
  assert.match(frontdesk, /booking\.status==='pending'/);
  assert.match(frontdesk, /confirmFrontdeskReview\(booking,'confirmed'\)/);
  assert.match(admin, /booking\.status === 'pending'/);
  assert.match(admin, /updateBookingStatus\(booking, 'confirmed'/);
});

test('AC-MOD-005: the member UI does not falsely claim the original appointment is unchanged', () => {
  assert.doesNotMatch(member, /原預約會保留至修改成功/);
  assert.match(member, /原預約時間可能釋出/);
  assert.match(member, /modifying \? '正在送出修改預約申請/);
});
