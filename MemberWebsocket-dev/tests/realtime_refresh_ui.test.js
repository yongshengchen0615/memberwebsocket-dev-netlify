const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('normal realtime surfaces do not expose redundant manual refresh controls', () => {
  const bookingHtml = read('booking/index.html');
  const bookingApp = read('booking/app.js');
  const pointsHtml = read('points/index.html');
  const pointsApp = read('points/app.js');
  const bookingAdmin = read('admin/booking-panel-core.js');

  assert.doesNotMatch(bookingHtml, /id="refreshButton"/);
  assert.doesNotMatch(bookingApp, /els\.refreshButton/);
  assert.doesNotMatch(pointsHtml, /id="refreshButton"/);
  assert.doesNotMatch(pointsApp, /els\.refreshButton/);
  assert.doesNotMatch(bookingAdmin, /bookingAdminRefreshButton/);
});

test('admin refresh remains recovery-only for uncertain writes', () => {
  const adminHtml = read('admin/index.html');
  const adminApp = read('admin/app.js');

  assert.match(
    adminHtml,
    /id="refreshButton" class="button button-outline hidden"[^>]*>重新整理確認<\/button>/
  );
  assert.match(adminApp, /els\.refreshButton\.classList\.remove\('hidden'\)/);
  assert.match(adminApp, /state\.writeConfirmationRequired[^\n]*window\.location\.reload/);
});

test('booking realtime no longer drives admin refresh through a button click', () => {
  const common = read('booking/common.js');

  assert.doesNotMatch(common, /refreshAdminFromRealtime/);
  assert.doesNotMatch(common, /waitForAdminRefreshCycle/);
  assert.doesNotMatch(common, /refreshButton\.click\(\)/);
  assert.match(common, /table: 'realtime_events'/);
});


test('admin booking modules reuse the single MemberSystem realtime feed', () => {
  const memberSystem = read('member-system.js');
  const bookingAdmin = read('admin/booking-panel-core.js');
  const cancellation = read('admin/booking-cancellation-sync.js');
  const receipts = read('admin/booking-receipt-admin.js');

  assert.match(memberSystem, /member-system:realtime-invalidation/);
  assert.match(memberSystem, /member-system:realtime-status/);
  assert.match(memberSystem, /getRealtimeStatus/);

  assert.match(bookingAdmin, /member-system:realtime-invalidation/);
  assert.doesNotMatch(bookingAdmin, /supabase\.createClient/);
  assert.doesNotMatch(bookingAdmin, /\.channel\(/);

  assert.match(cancellation, /member-system:realtime-invalidation/);
  assert.match(cancellation, /member-system:realtime-status/);
  assert.doesNotMatch(cancellation, /supabase\.createClient/);
  assert.doesNotMatch(cancellation, /\.channel\(/);

  assert.match(receipts, /member-system:realtime-invalidation/);
  assert.match(receipts, /booking\.receipt\./);
  assert.doesNotMatch(receipts, /supabase\.createClient/);
  assert.doesNotMatch(receipts, /\.channel\(/);
});

test('booking child tables have statement-level realtime invalidation triggers', () => {
  const migration = read('supabase/migrations/20260919062515_complete_realtime_invalidation_coverage.sql');
  for (const table of [
    'booking_items',
    'booking_technicians',
    'booking_participants',
    'booking_participant_items',
    'booking_participant_reservations',
  ]) {
    assert.match(migration, new RegExp(`on public\\.${table}\\nfor each statement execute function public\\.notify_booking_realtime_change\\(\\);`));
  }
});


test('user-visible data tables have transactional realtime invalidation coverage', () => {
  const migration = read('supabase/migrations/20260919062515_complete_realtime_invalidation_coverage.sql');
  for (const table of [
    'point_card_settings',
    'point_balances',
    'point_entries',
    'point_tickets',
    'service_time_entries',
    'fixed_ticket_templates',
  ]) {
    assert.match(migration, new RegExp(`on public\\.${table}\\nfor each statement execute function public\\.notify_surface_realtime_change\\(\\);`));
  }
  assert.match(migration, /realtime_member_profile_change/);
  assert.match(migration, /member\.db\.members\.profile/);
});

test('admin extensions reload their authoritative data after realtime refresh', () => {
  const adminHtml = read('admin/index.html');
  const adminApp = read('admin/app.js');
  const fixedTickets = read('admin/fixed-ticket-admin.js');
  const pointLimit = read('admin/pointcard-redemption-limit.js');

  assert.match(adminHtml, /pointcard-redemption-limit\.js\?v=policy-admin-ui-20261014-1/);
  assert.match(adminApp, /member-admin-data-refreshed/);
  assert.match(fixedTickets, /member-admin-data-refreshed/);
  assert.match(fixedTickets, /loadTemplates\(\)/);
  assert.match(pointLimit, /MemberAdminSession\.wait/);
  assert.doesNotMatch(pointLimit, /window\.liff/);
  assert.doesNotMatch(pointLimit, /getIDToken/);
  assert.match(pointLimit, /member-admin-data-refreshed/);
  assert.match(pointLimit, /loadSetting\(\)/);
});

test('points realtime refresh also reloads point ticket policy', () => {
  const app = read('points/app.js');
  const overview = read('points/pointcard-ticket-overview.js');

  assert.match(app, /PointCardTicketOverview\.refreshSettings\(\)/);
  assert.match(overview, /async function refreshSettings\(\)/);
  assert.match(overview, /Object\.freeze\(\{ initialize, refreshSettings, renderSnapshot \}\)/);
});

test('point transfer stays synchronized without a full page reload', () => {
  const app = read('points/app.js');
  const transfer = read('points/point-transfer.js');

  assert.match(app, /PointCardClient = Object\.freeze\(\{ refresh: \(\) => loadCards\(false\) \}\)/);
  assert.match(transfer, /pointcard:active-changed/);
  assert.match(transfer, /visibilitychange/);
  assert.match(transfer, /window\.addEventListener\('online'/);
  assert.match(transfer, /PointCardClient\.refresh/);
  assert.doesNotMatch(transfer, /window\.location\.reload/);
});

test('point transfer shows the member code, removes outer copy and keeps QR dialog copy', () => {
  const transfer = read('points/point-transfer.js');
  const qrDialog = read('qr-scan-dialog.js');
  const css = read('points/point-transfer.css');

  assert.match(transfer, /pointTransferOwnMemberCode/);
  assert.match(transfer, /pointTransferShowOwnQr/);
  assert.doesNotMatch(transfer, /pointTransferCopyOwnCode|copyOwnMemberCode/);
  assert.match(transfer, /profile\?\.memberCode/);
  assert.match(qrDialog, /copy\.textContent = '複製會員編號'/);
  assert.match(qrDialog, /navigator\.clipboard\.writeText\(code\)/);
  assert.match(css, /\.point-transfer-own-code/);
  assert.match(css, /html\[data-theme="dark"\] \.point-transfer-own-code/);
});
