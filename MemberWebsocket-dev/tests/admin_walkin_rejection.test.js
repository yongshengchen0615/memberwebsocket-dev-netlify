const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const ui = read('admin/booking-panel-core.js');
const api = read('supabase/functions/booking-api/index.ts');
const runtime = read('supabase/functions/_shared/business-runtime.ts');
const sql = read('supabase/migrations/20261122160000_admin_walkin_conflict_reject.sql');

test('AC-ADM-WALKIN-001: Reject opens accessible reason modal; no reason blocks submission', () => {
  assert.match(ui, /actionButton\('不通過'.*openRejectionModal\(booking, textarea\.value\)/);
  assert.match(ui, /data-admin-rejection-form novalidate/);
  assert.match(ui, /<option value="">請選擇拒絕原因<\/option>/);
  assert.match(ui, /\!\['technician_leave','unrecorded_phone_booking'\]\.includes\(reason\.value\)/);
  assert.match(ui, /showMessage\(feedback,'請先選擇拒絕原因。'/);
  assert.match(ui, /reason\.focus\(\)/);
});

test('AC-ADM-WALKIN-002/003: Walk-in option requires actual start and total duration within merchant 10-minute limits', () => {
  assert.match(ui, /data-rejection-phone hidden/);
  assert.match(ui, /phone\.hidden = !isPhone/);
  assert.match(ui, /衝突預約時間（每 10 分鐘）/);
  assert.match(ui, /衝突預約總時長（每 10 分鐘）/);
  assert.match(ui, /state\.booking\.frontdeskConflictPolicy/);
  for (const key of ['conflictStartMin','conflictStartMax','conflictDurationMin','conflictDurationMax']) {
    assert.ok(ui.includes(key), 'missing UI policy ' + key);
    assert.ok(api.includes(key), 'missing server-sourced policy ' + key);
    assert.ok(sql.includes(key), 'missing database policy ' + key);
  }
  assert.match(api, /frontdeskConflictPolicy: policy/);
  assert.match(ui, /value<=startMax; value\+=10/);
  assert.match(ui, /value<=durationMax; value\+=10/);
  assert.match(api, /duration%10!==0/);
  assert.match(sql, /v_clock%10<>0/);
  assert.match(sql, /v_duration%10<>0/);
});

test('AC-ADM-WALKIN-004/005: Half-open overlap blocks empty/boundary-only conflict, including overnight', () => {
  const overlap = (start, minutes, originalStart, originalMinutes) =>
    [start, start + 1440].some(candidate =>
      candidate < originalStart + originalMinutes && candidate + minutes > originalStart);
  assert.equal(overlap(11 * 60, 60, 10 * 60, 60), false, 'touching end is not a conflict');
  assert.equal(overlap(9 * 60, 60, 10 * 60, 60), false, 'touching start is not a conflict');
  assert.equal(overlap(10 * 60 + 10, 10, 10 * 60, 60), true, 'strictly inside');
  assert.equal(overlap(0, 30, 23 * 60 + 50, 40), true, 'overnight');
  assert.equal(overlap(1 * 60, 10, 23 * 60 + 50, 40), false, 'overnight boundary-only');
  assert.match(ui, /\[selected,selected\+1440\]\.some\(candidate/);
  assert.match(ui, /candidate < originalEnd && candidate\+total > originalStart/);
  assert.match(ui, /if \(isPhone && !overlapping\(\)\)/);
  assert.match(sql, /booking_slot_start_at/);
  assert.match(sql, /v_candidate >= .*start_at/);
  assert.match(sql, /v_candidate \+ make_interval\(mins=>v_duration\)/);
  assert.match(sql, /ADMIN_WALKIN_NOT_OVERLAPPING/);
});

test('AC-ADM-WALKIN-006: Legacy status API cannot reject with walk-in reason without atomic details', () => {
  assert.match(api, /if \(nextStatus === "rejected" && rejectionReason === "unrecorded_phone_booking"\)/);
  assert.match(api, /ADMIN_WALKIN_DETAILS_REQUIRED/);
  assert.match(api, /if \(action === "admin\.booking\.reject-walkin"\)/);
  assert.match(api, /Number\.isInteger\(duration\)/);
  assert.match(api, /"admin\.booking\.reject-walkin"/);
  assert.match(api, /phoneRequestId:"PHONE-"\+requestId/);
});

test('AC-ADM-WALKIN-007: API and database revalidate verified admin, tenant, revocation and version', () => {
  assert.match(runtime, /if\(name==='platform_admin_reject_walkin'\)/);
  assert.match(runtime, /if\(!current\.verifiedAdmin \|\| params\?\.p_actor!==current\.verifiedAdmin\.actor\)/);
  assert.match(runtime, /p_tenant_id:current\.id/);
  assert.match(runtime, /p_issued_at:current\.verifiedAdmin\.issuedAt/);
  assert.match(sql, /p_actor is distinct from t\.owner_line_user_id/);
  assert.match(sql, /t\.features->>'booking' is distinct from 'true'/);
  assert.match(sql, /p_issued_at<=coalesce\(t\.access_revoked_before/);
  assert.match(sql, /where line_user_id=\$1 and status=''active'' and role=''admin''/);
  assert.match(sql, /for update/);
  assert.match(sql, /BOOKING_CANCELLATION_PENDING/);
  assert.match(sql, /BOOKING_CONFLICT/);
  assert.doesNotMatch(sql, /grant execute on function public\.platform_admin_reject_walkin[^;]+to (?:anon|authenticated)/i);
});

test('AC-ADM-WALKIN-008: Both booking changes, auditing, confirmation and replay are in one SQL call', () => {
  assert.match(sql, /create or replace function public\.platform_admin_reject_walkin/);
  assert.match(sql, /update %I\.bookings b set status=''rejected''/);
  assert.match(sql, /'BOOKING_REJECTED'/);
  assert.match(sql, /replacement:=platform_private\.admin_create_duration_booking/);
  assert.match(sql, /'BOOKING_PHONE_CREATED'/);
  assert.match(sql, /status=''confirmed''/);
  assert.match(sql, /reject_audit\.actor_role=phone_audit\.actor_role/);
  assert.match(sql, /phone_audit\.actor_role in \(''frontdesk'',''admin''\)/);
  assert.match(sql, /perform pg_advisory_xact_lock/);
  assert.match(sql, /platform_private\.requests/);
  assert.match(sql, /payload_hash<>v_hash/);
  assert.match(sql, /alreadyApplied.*true/);
  assert.doesNotMatch(api, /from\("bookings"\)\.update\(.*unrecorded_phone_booking/);
});

test('AC-ADM-WALKIN-009: Existing merchants and provisioning templates preserve identical audit bundle invariants', () => {
  assert.match(sql, /for t in select runtime_schema from platform_private\.tenants loop/);
  assert.match(sql, /assert_booking_item_bundle/);
  assert.match(sql, /platform_private\.business_templates/);
  assert.match(sql, /ADMIN_WALKIN_BUNDLE_CONTRACT_CHANGED/);
  assert.match(sql, /ADMIN_WALKIN_TEMPLATE_CONTRACT_CHANGED/);
  assert.match(sql, /phone_audit\.actor_role in \(''frontdesk'',''admin''\)/);
  assert.match(sql, /reject_audit\.actor_role=phone_audit\.actor_role/);
});
