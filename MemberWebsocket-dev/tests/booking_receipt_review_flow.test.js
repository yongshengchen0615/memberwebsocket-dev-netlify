const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('member receipt camera and bounded image picker share secure admin-review submission', () => {
  const source = read('booking/booking-receipt.js');
  assert.match(source, /navigator\.mediaDevices\?\.getUserMedia/);
  assert.match(source, /facingMode:\s*\{\s*ideal:\s*'environment'\s*\}/);
  assert.match(source, /bookingReceiptCamera/);
  assert.match(source, /captureFrame/);
  assert.match(source, /id="bookingReceiptFile" type="file"/);
  assert.match(source, /acceptFile\(file\)/);
  assert.match(source, /bookingReceiptDiscard/);
  assert.match(source, /file\.size > 5 \* 1024 \* 1024/);
  assert.match(source, /此瀏覽器無法使用相機，請改用選擇收據圖片功能/);
  assert.match(source, /uploadToSignedUrl/);
  assert.match(source, /user\.booking\.receipt\.finalize/);
});

test('member receipt submission waits for admin review', () => {
  const source = read('booking/booking-receipt.js');
  const edge = read('supabase/functions/booking-receipt-api/index.ts');
  const migration = read('supabase/migrations/20261001125500_booking_receipt_admin_confirmation.sql');
  assert.match(source, /等待管理端確認/);
  assert.match(edge, /finalize_booking_receipt_request/);
  assert.match(migration, /status='awaiting_review'/);
  assert.match(migration, /user\.booking\.receipt\.submit/);
  assert.doesNotMatch(edge, /p_reason:"booking-completion-failed"/);
});

test('admin completes bookings through the canonical booking flow while the receipt snapshot stays view-only', () => {
  const admin = read('admin/booking-receipt-admin.js');
  const panel = read('admin/booking-panel-core.js');
  const operations = read('supabase/functions/booking-admin-operations/index.ts');
  const migration = read('supabase/migrations/20261001125500_booking_receipt_admin_confirmation.sql');

  assert.match(admin, /查看收據快照/);
  assert.doesNotMatch(admin, /確認收據並完成預約/);
  assert.doesNotMatch(admin, /admin\.booking\.status\.complete/);
  assert.match(panel, /確認服務完成/);
  assert.match(panel, /確認完成並結算/);
  assert.match(panel, /admin\.booking\.status\.complete/);
  assert.doesNotMatch(admin, /等待會員上傳收據/);
  assert.doesNotMatch(admin, /管理端不可直接完成預約/);
  assert.match(operations, /admin_confirm_booking_receipt_request/);
  assert.match(operations, /complete_booking_with_rewards_request/);
  assert.match(operations, /receiptConfirmed/);
  assert.doesNotMatch(operations, /請先等待會員拍攝並送出收據/);
  assert.match(migration, /nextReceiptStatus','bound'/);
});

test('completed bookings keep their secure receipt snapshot viewer after admin queue re-renders', () => {
  const admin = read('admin/booking-receipt-admin.js');
  const panel = read('admin/booking-panel-core.js');
  const edge = read('supabase/functions/booking-receipt-api/index.ts');

  assert.match(panel, /data-booking-filter="completed"/);
  assert.match(admin, /\['awaiting_review', 'bound'\]\.includes/);
  assert.match(admin, /查看收據快照/);
  assert.match(admin, /new MutationObserver/);
  assert.match(admin, /queueObserver\.observe\(queue, \{ childList: true \}\)/);
  assert.match(admin, /member-system:realtime-invalidation/);
  assert.match(admin, /eventType\.startsWith\('booking\.receipt\.'\)/);
  assert.match(admin, /state\.refreshQueued = true/);
  assert.match(admin, /admin\.booking\.receipt\.url/);
  assert.match(edge, /\.in\("status",\["awaiting_review","bound"\]\)/);
  assert.match(edge, /createSignedUrl\(String\(result\.data\.object_path\),120\)/);
});


test('member and admin receipt snapshot UI follow shared dark theme tokens', () => {
  const memberCss = read('booking/booking-receipt.css');
  const adminCss = read('admin/booking-receipt-admin.css');

  for (const css of [memberCss, adminCss]) {
    assert.match(css, /var\(--theme-overlay/);
    assert.match(css, /var\(--theme-surface-raised/);
    assert.match(css, /var\(--theme-surface-muted/);
    assert.match(css, /var\(--theme-text/);
    assert.match(css, /var\(--theme-text-muted/);
    assert.match(css, /var\(--theme-border/);
    assert.match(css, /var\(--theme-modal-shadow/);
    assert.doesNotMatch(css, /var\(--surface,/);
    assert.doesNotMatch(css, /var\(--surface-container/);
  }

  assert.match(memberCss, /var\(--theme-danger-soft/);
  assert.match(memberCss, /var\(--theme-positive-soft/);
  assert.match(memberCss, /html\[data-theme="dark"\] \.booking-receipt-modal-card/);
  assert.match(adminCss, /html\[data-theme="dark"\] \.admin-booking-receipt-card/);
});

test('confirmed bookings can upload receipts before service end and reupload overwrites the current snapshot', () => {
  const source = read('booking/booking-receipt.js');
  const edge = read('supabase/functions/booking-receipt-api/index.ts');
  const migration = read('supabase/migrations/20261002160040_booking_receipt_replace_before_service_end.sql');

  assert.match(source, /預約確認後即可上傳，不需等待服務時間結束/);
  assert.match(source, /重新拍攝並覆蓋收據/);
  assert.match(source, /重新拍攝會覆蓋目前快照/);
  assert.doesNotMatch(source, /服務時間結束後即可拍攝收據/);

  assert.match(edge, /canSubmitReceipt:row\.status==="confirmed"&&!cancellationPending,/);
  assert.match(edge, /createSignedUploadUrl\(path,\{upsert:false\}\)/);

  assert.doesNotMatch(migration, /BOOKING_NOT_FINISHED_YET/);
  assert.match(migration, /where booking_id=p_booking_id and status='awaiting_review'/);
  assert.match(migration, /status='pending_upload'/);
  assert.match(migration, /'objectPath',v_receipt\.object_path/);
  assert.match(migration, /'replacedExisting',true/);
  assert.match(migration, /booking\.receipt\.pending_upload/);
});
