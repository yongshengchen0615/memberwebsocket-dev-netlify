const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const app = read('admin/app.js');
const core = read('admin/booking-panel-core.js');
const accessibleAdmin = read('admin/booking-accessible-admin.js');
const migration = read('supabase/migrations/20261003211500_accessible_free_time_and_reward_service_guard.sql');

test('reward-node booking service choices exclude the internal store service', () => {
  assert.match(app, /const STORE_SERVICE_ID = '00000000-0000-4000-8000-000000000010'/);
  assert.match(app, /service\.serviceId !== STORE_SERVICE_ID/);
  assert.match(migration, /bs\.id <> '00000000-0000-4000-8000-000000000010'::uuid/);
});

test('reward-node booking service choices receive live booking catalog updates', () => {
  assert.match(core, /member-admin:booking-services-updated/);
  assert.match(core, /detail: \{ services: nextCatalog\.services \}/);
  assert.match(app, /member-admin:booking-services-updated/);
  assert.match(app, /handleBookingServicesUpdated/);
  assert.match(app, /querySelectorAll\('\[data-reward-required-service-ids\]'\)/);
  assert.match(core, /booking\.db\.booking_services\./);
  assert.match(core, /if \(catalogInvalidation\) refreshAll\(false, false\)/);
  assert.match(core, /else refreshAll\(false, true\)/);
});

test('accessible receipt registration accepts minute-level start times independent of slot interval', () => {
  assert.match(accessibleAdmin, /id="accessibleAdminTime" type="time" step="60"/);
  const start = migration.indexOf('create or replace function public.register_accessible_receipt_request');
  const end = migration.indexOf('create or replace function public.save_point_card_service_items', start);
  const section = migration.slice(start, end);
  assert.match(section, /extract\(second from p_start_time\)<>0/);
  assert.doesNotMatch(section, /extract\(minute from p_start_time\).*%5/);
  assert.doesNotMatch(section, /slot_interval/i);
});


test('accessible receipt bookings bypass only the normal five-minute start constraint', () => {
  const constraintMigration = read('supabase/migrations/20261003214500_accessible_booking_start_boundary_exception.sql');
  const receiptApi = read('supabase/functions/booking-receipt-api/index.ts');
  assert.match(constraintMigration, /receipt_submission_id is not null/);
  assert.match(constraintMigration, /request_id like 'receipt-register:%'/);
  assert.match(constraintMigration, /extract\(minute from start_time\)::integer % 5 = 0/);
  assert.match(receiptApi, /bookings_start_boundary_check/);
  assert.doesNotMatch(receiptApi, /每 5 分鐘的服務開始時間/);
});


test('accessible receipt ticket review uses canonical benefit settlement', () => {
  const admin = read('admin/booking-accessible-admin.js');
  const receiptApi = read('supabase/functions/booking-receipt-api/index.ts');
  const migration = read('supabase/migrations/20261003221000_accessible_receipt_ticket_review.sql');
  assert.match(admin, /審核票券與點數/);
  assert.match(admin, /benefits,adminNote/);
  assert.match(receiptApi, /loadBookingBenefits/);
  assert.match(receiptApi, /validateAccessibleBenefits/);
  assert.match(receiptApi, /register_snapshot_receipt_v2/);
  assert.match(read('supabase/migrations/20261010084712_membership_snapshot_and_completion_controls.sql'), /return public\.register_accessible_receipt_with_benefits_request/);
  assert.match(migration, /replace_booking_benefit_selections_request/);
  assert.match(migration, /admin_confirm_booking_receipt_request/);
  assert.match(migration, /benefitCount/);
});


test('accessible ticket review calculates aggregate point budgets', () => {
  const admin = read('admin/booking-accessible-admin.js');
  assert.match(admin, /function pointBudgetSnapshot\(\)/);
  assert.match(admin, /function pointBudgetExceeded\(\)/);
  assert.match(admin, /本次扣除/);
  assert.match(admin, /審核後剩餘/);
  assert.match(admin, /dataset\.pointCost/);
  assert.match(admin, /dataset\.pointBalance/);
  assert.match(admin, /會員目前可用點數不足/);
});


test('accessible review UI separates receipt, workflow and sticky actions', () => {
  const admin = read('admin/booking-accessible-admin.js');
  const css = read('admin/booking-accessible-admin.css');
  const index = read('admin/index.html');
  assert.match(admin, /快照預約審核/);
  assert.match(admin, /accessible-admin-review-layout/);
  assert.match(admin, /accessible-admin-receipt-pane/);
  assert.match(admin, /accessible-admin-step-heading/);
  assert.match(admin, /accessible-admin-sticky-actions/);
  assert.match(admin, /需 \$\{cost\} 點 · 可用 \$\{balance\} 點/);
  assert.match(css, /grid-template-columns:minmax\(280px,.72fr\) minmax\(480px,1.28fr\)/);
  assert.match(css, /@media\(max-width:640px\)/);
  assert.match(css, /\.accessible-admin-sticky-actions/);
  assert.match(index, /accessible-history-20261003-1/);
});


test('accessible review uses one vertical scroll container', () => {
  const css = read('admin/booking-accessible-admin.css');
  const index = read('admin/index.html');
  assert.match(css, /\.accessible-admin-review-layout\{[\s\S]*overflow-y:auto/);
  assert.match(css, /\.accessible-admin-review-form\{[\s\S]*overflow:visible/);
  assert.match(css, /\.accessible-admin-receipt-pane\{[\s\S]*overflow:visible/);
  assert.doesNotMatch(css, /#accessibleAdminModal\{[^}]*touch-action:none/);
  assert.match(index, /accessible-history-20261003-1/);
});


test('accessible review mounts only inside its dedicated queue mode', () => {
  const admin = read('admin/booking-accessible-admin.js');
  assert.match(admin, /section\.className = 'accessible-admin-queue hidden'/);
  assert.match(admin, /panel\.append\(section\)/);
  assert.doesNotMatch(admin, /panel\.prepend\(section\)/);
  assert.match(admin, /function syncQueueMode\(\)/);
  assert.match(admin, /data-queue-mode/);
  assert.match(admin, /member-admin:booking-queue-mode-changed/);
});


test('accessible review keeps completed records with pending completed and all filters', () => {
  const admin = read('admin/booking-accessible-admin.js');
  const receiptAdmin = read('admin/booking-receipt-admin.js');
  const receiptApi = read('supabase/functions/booking-receipt-api/index.ts');
  const css = read('admin/booking-accessible-admin.css');
  assert.match(admin, /data-accessible-filter="pending"/);
  assert.match(admin, /data-accessible-filter="completed"/);
  assert.match(admin, /data-accessible-filter="all"/);
  assert.match(admin, /state\.filter = 'completed'/);
  assert.match(admin, /查看紀錄/);
  assert.match(admin, /openRecord\(receipt\)/);
  assert.match(receiptAdmin, /accessibleRecords/);
  assert.match(receiptApi, /accessibleRecords/);
  assert.match(receiptApi, /reviewStatus:status==="awaiting_review"\?"pending":status==="bound"\?"completed"/);
  assert.match(receiptApi, /booking_completion_settlements/);
  assert.match(receiptApi, /booking_benefit_selections/);
  assert.match(css, /accessible-admin-history-tabs/);
  assert.match(css, /accessible-admin-record-detail/);
});


test('completed accessible review can reopen its bound receipt snapshot', () => {
  const receiptApi = read('supabase/functions/booking-receipt-api/index.ts');
  const start = receiptApi.indexOf('async function adminUrl');
  const end = receiptApi.indexOf('function selectionLimit', start);
  const adminUrl = receiptApi.slice(start, end);
  assert.match(adminUrl, /eq\("submission_mode","accessible"\)/);
  assert.match(adminUrl, /in\("status",\["awaiting_review","bound"\]\)/);
  assert.doesNotMatch(adminUrl, /is\("booking_id",null\)/);
  assert.match(adminUrl, /bookingId:String\(receipt\.data\.booking_id\|\|""\)/);
});
