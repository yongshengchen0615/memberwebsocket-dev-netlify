const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20261120194500_member_pending_official_line_notice.sql');
const member = read('booking/app.js');
const common = read('booking/common.js');
const admin = read('admin/booking-panel-core.js');
const adminApi = read('supabase/functions/booking-admin-api/index.ts');
const worker = read('supabase/functions/booking-line-notifications/index.ts');
const delivery = read('supabase/functions/booking-line-notifications/delivery.ts');

test('AC-BPN-001: member does not send booking chat with LIFF; official LINE owns delivery', () => {
  assert.doesNotMatch(common, /liff\.sendMessages\s*\(/);
  assert.doesNotMatch(member, /sendBookingMemberChatMessage|bookingMemberChatText/);
  assert.match(member, /等待管理端確認/);
  assert.match(migration, /:created:member/);
});
test('AC-BPN-002: per-merchant settings include a validated template controlled by admin', () => {
  assert.match(migration, /alter table public\.booking_settings[\s\S]*?add column if not exists pending_message/);
  assert.match(migration, /char_length\(btrim\(pending_message\)\) between 1 and 400/);
  assert.match(adminApi, /pendingMessage: String\(row\?\.pending_message/);
  assert.match(adminApi, /admin\.booking\.pending-message\.save/);
  assert.match(adminApi, /typeof body\.pendingMessage !== 'string'/);
  assert.match(adminApi, /pendingMessage\.length > 400/);
  assert.match(adminApi, /\.eq\('updated_at', expectedUpdatedAt\)/);
  assert.match(adminApi, /BOOKING_PENDING_MESSAGE_UPDATED/);
});
test('AC-BPN-003: admin has independent editor, preview and safe text rendering', () => {
  for (const id of ['bookingAdminPendingMessageForm','bookingAdminPendingMessage','bookingAdminPendingMessagePreview','bookingAdminPendingMessageSave']) {
    assert.match(admin, new RegExp(id));
  }
  assert.match(admin, /renderPendingMessagePreview/);
  assert.match(admin, /bookingAdminPendingMessagePreview\.textContent =/);
  assert.match(admin, /manageRequest\('admin\.booking\.pending-message\.save'/);
  assert.match(admin, /pendingMessageDirty/);
});
test('AC-BPN-004: insert-only pending notice uses tenant-scoped outbox, active non-test member and idempotent event', () => {
  assert.match(migration, /TG_OP <> 'INSERT' or NEW\.status <> 'pending'/);
  assert.match(migration, /NEW\.contact_source is distinct from 'member'/);
  assert.match(migration, /status=''active'' and coalesce\(is_test_account,false\)=false/);
  assert.match(migration, /runtime_schema=v_schema/);
  assert.match(migration, /on conflict \(event_key,channel,recipient\) do nothing/);
  assert.match(migration, /booking_notifications/);
  assert.match(migration, /notice_outbox/);
  assert.match(migration, /create trigger bookings_enqueue_member_pending_line_notice/);
});
test('AC-BPN-005: newly created tenant receives same policy and existing tenants are upgraded', () => {
  assert.match(migration, /platform_private\.install_booking_pending_notice\(p_schema\)/);
  assert.match(migration, /platform_private\.install_booking_reminder\(text\)/);
  assert.match(migration, /for v_schema in select runtime_schema from platform_private\.tenants/);
});
test('AC-BPN-006: delayed notification cannot tell confirmed bookings to wait', () => {
  assert.match(worker, /event_key \|\| ''\)\.endsWith\(':created:member'\)/);
  assert.match(worker, /pending\.data\?\.status !== 'pending'/);
  assert.match(worker, /BOOKING_NO_LONGER_PENDING/);
  assert.match(delivery, /'預約申請': \{ color:/);
});
