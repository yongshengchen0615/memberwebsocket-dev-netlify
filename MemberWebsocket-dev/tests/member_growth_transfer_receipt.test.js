const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('member growth API keeps referral and point transfer writes behind server RPC boundaries', () => {
  const api = read('supabase/functions/member-growth-api/index.ts');
  const referral = read('supabase/migrations/20260930150500_member_referral_rewards.sql');
  const transfer = read('supabase/migrations/20260930151500_point_transfer_atomic.sql');

  assert.match(api, /verifyLineIdTokenContract/);
  assert.match(api, /resolveUserTestIdentity/);
  assert.match(api, /hasCurrentTermsConsent/);
  assert.match(api, /consume_api_rate_limit/);
  assert.match(api, /bind_member_referral/);
  assert.match(api, /transfer_member_points/);

  assert.match(referral, /unique references public\.members\(id\)/);
  assert.match(referral, /SELF_REFERRAL_NOT_ALLOWED/);
  assert.match(referral, /REFERRAL_CYCLE_NOT_ALLOWED/);
  assert.match(referral, /rewardCount',2/);

  assert.match(transfer, /for update/);
  assert.match(transfer, /REQUEST_ID_CONFLICT/);
  assert.match(transfer, /transfer_out/);
  assert.match(transfer, /transfer_in/);
  assert.match(transfer, /point_transfers_sender_request_unique/);
});


test('member join completion sends the LINE message automatically without a member-card send action', () => {
  const ui = read('member/member-growth.js');

  assert.match(ui, /joinSubmitted:\s*false/);
  assert.match(ui, /profileForm/);
  assert.match(ui, /member-profile-ready/);
  assert.match(ui, /liff\.isInClient/);
  assert.match(ui, /context\.type\s*!==\s*'utou'/);
  assert.match(ui, /liff\.sendMessages/);
  assert.match(ui, /我已完成 Lumen Club 會員註冊/);
  assert.doesNotMatch(ui, /member\.line\.official-account/);
  assert.doesNotMatch(ui, /仍需由你按下傳送/);
  assert.doesNotMatch(ui, /window\.location\.assign/);
});

test('booking receipt uses private upload, waits for admin review, and keeps the snapshot viewer read-only', () => {
  const edge = read('supabase/functions/booking-receipt-api/index.ts');
  const baseMigration = read('supabase/migrations/20260930152500_booking_receipt_completion.sql');
  const reviewMigration = read('supabase/migrations/20261001125500_booking_receipt_admin_confirmation.sql');
  const retention = read('supabase/migrations/20261001094500_receipt_retention_cleanup.sql');
  const testControl = read('supabase/functions/test-control-api/index.ts');
  const memberUi = read('booking/booking-receipt.js');
  const adminUi = read('admin/booking-receipt-admin.js');
  const bookingAdmin = read('admin/booking-panel-core.js');

  assert.match(baseMigration, /'booking-receipts'/);
  assert.match(baseMigration, /values\(\s*'booking-receipts',\s*'booking-receipts',\s*false,/);
  assert.match(baseMigration, /BOOKING_NOT_OWNED/);
  assert.match(baseMigration, /BOOKING_NOT_FINISHED_YET/);

  assert.match(reviewMigration, /status='awaiting_review'/);
  assert.match(reviewMigration, /admin_confirm_booking_receipt_request/);
  assert.match(reviewMigration, /complete_booking_with_rewards_request/);
  assert.match(reviewMigration, /status='bound'/);

  assert.match(edge, /createSignedUploadUrl/);
  assert.match(edge, /sniffMime/);
  assert.match(edge, /fileSha256Hex/);
  assert.match(edge, /finalize_booking_receipt_request/);
  assert.match(edge, /createSignedUrl\(String\(result\.data\.object_path\),120\)/);
  assert.match(edge, /expire_stale_booking_receipts/);
  assert.match(retention, /Pending uploads older than 24 hours/);
  assert.match(retention, /status='pending_upload'/);
  assert.match(testControl, /purgeBookingReceiptCleanupQueue/);
  assert.match(testControl, /BOOKING_RECEIPT_BUCKET = "booking-receipts"/);

  assert.match(memberUi, /navigator\.mediaDevices\?\.getUserMedia/);
  assert.match(memberUi, /type="file"/);
  assert.match(memberUi, /id="bookingReceiptFile"/);
  assert.match(memberUi, /acceptFile\(file\)/);
  assert.match(memberUi, /bookingReceiptDiscard/);
  assert.match(memberUi, /state\.busy \|\| !file/);
  assert.match(memberUi, /5 \* 1024 \* 1024/);
  assert.match(memberUi, /member:access-ended/);
  assert.match(memberUi, /uploadToSignedUrl/);
  assert.match(memberUi, /user\.booking\.receipt\.finalize/);
  assert.match(memberUi, /等待管理端確認/);
  assert.match(adminUi, /admin\.booking\.receipt\.url/);
  assert.match(adminUi, /renderBookingSummary/);
  assert.match(adminUi, /預約項目/);
  assert.match(adminUi, /查看收據快照/);
  assert.doesNotMatch(adminUi, /確認收據並完成預約/);
  assert.doesNotMatch(adminUi, /admin\.booking\.status\.complete/);
  assert.match(bookingAdmin, /確認服務完成/);
  assert.match(bookingAdmin, /admin\.booking\.status\.complete/);
  assert.doesNotMatch(adminUi, /等待會員上傳收據/);
  assert.doesNotMatch(adminUi, /由會員拍攝收據完成/);
});

test('today usable count is server-derived and rendered separately from claim inventory', () => {
  const migration = read('supabase/migrations/20260930153500_today_usable_event_ticket_count.sql');
  const ui = read('event/today-usable.js');

  assert.match(migration, /Asia\/Taipei/);
  assert.match(migration, /c\.status='claimed'/);
  assert.match(migration, /current_tier_key/);
  assert.match(ui, /今日可使用/);
  assert.match(ui, /暫時無法取得/);
});
