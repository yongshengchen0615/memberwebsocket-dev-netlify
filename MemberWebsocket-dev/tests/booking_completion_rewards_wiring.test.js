const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('booking service type UI exposes completion reward settings', () => {
  const source = read('admin/booking-panel-core.js');
  assert.match(source, /data-type-reward-enabled/);
  assert.match(source, /data-type-reward-minutes/);
  assert.match(source, /data-type-reward-card/);
  assert.match(source, /店內服務時間不計入/);
  assert.match(source, /完成結算預覽/);
  assert.match(source, /真正的服務時間、集點、LINE 通知與重複請求判斷仍由 Server-side 完成結算流程決定/);
  assert.match(source, /確認完成並結算/);
});

test('booking admin API persists service type reward settings server-side', () => {
  const source = read('supabase/functions/booking-admin-api/index.ts');
  assert.match(source, /booking_service_type_rewards/);
  assert.match(source, /save_booking_service_type/);
  assert.match(source, /rewardMinutesPerPoint/);
  assert.match(source, /rewardPointCardId/);
});

test('booking completion requires admin receipt confirmation and keeps settlement transactional', () => {
  const source = read('supabase/functions/booking-admin-operations/index.ts');
  const migration = read('supabase/migrations/20261001125500_booking_receipt_admin_confirmation.sql');
  assert.match(source, /admin_confirm_booking_receipt_request/);
  assert.match(migration, /complete_booking_with_rewards_request/);
  assert.match(migration, /status='awaiting_review'/);
  assert.doesNotMatch(source, /status:\s*"completed"[\s\S]*\.from\("bookings"\)\.update/);
});

test('completed LINE notifications include settlement results', () => {
  const source = read('supabase/functions/booking-line-notifications/index.ts');
  assert.match(source, /booking_completion_settlements/);
  assert.match(source, /completionSummary/);
  const summary=read('supabase/functions/booking-line-notifications/completion-summary.ts');
  assert.match(summary, /完成服務時間/);
  assert.match(summary, /獲得集點/);
  assert.match(source,/friend_booking_rewards/);
});

test('migration excludes store service and protects idempotency', () => {
  const source = read('supabase/migrations/20260919084927_booking_service_type_completion_rewards.sql');
  assert.match(source, /00000000-0000-4000-8000-000000000010/);
  assert.match(source, /booking_completion_settlements/);
  assert.match(source, /booking-complete:/);
  assert.match(source, /on conflict \(request_id, member_id, point_card_id\)/i);
  assert.match(source, /on conflict \(request_id, member_id\)/i);
  assert.match(source, /revoke all on function public\.complete_booking_with_rewards_request/);
});
