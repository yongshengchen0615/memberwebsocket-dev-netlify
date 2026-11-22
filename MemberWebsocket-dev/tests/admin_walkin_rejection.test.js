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

test('AC-WALKIN-WINDOW-001/002: admin displays original-window 10-minute starts and independent duration',()=>{
 const migration=read('supabase/migrations/20261122163500_walkin_original_window_inclusive.sql');
 assert.match(ui,/data-rejection-phone hidden/);
 assert.match(ui,/phone\.hidden = !isPhone/);
 assert.match(ui,/衝突預約時間（每 10 分鐘）/);
 assert.match(ui,/衝突預約總時長（每 10 分鐘）/);
 assert.match(ui,/value<=originalEnd;value\+=10/);
 assert.match(ui,/value=10;value<=1430;value\+=10/);
 assert.doesNotMatch(ui,/state\.booking\.frontdeskConflictPolicy \|\|/);
 assert.match(api,/duration%10!==0/);
 assert.match(migration,/v_old_admin_bounds/);
 assert.match(migration,/v_new_bounds/);
 assert.match(migration,/minimum supported schedule step \(5\)/,'10-minute walk-in clock starts remain valid with a normal 30-minute calendar');
});

test('AC-WALKIN-WINDOW-003/005: boundary-only adjacency counts, out-of-window is invalid, and overnight works',()=>{
 const allowed=(start,minutes,originalStart,originalMinutes)=>
  [start,start+1440].some(candidate=>
   candidate>=originalStart&&candidate<=originalStart+originalMinutes&&minutes>0);
 assert.equal(allowed(10*60+10,10,9*60,70),true,'original end is included');
 assert.equal(allowed(9*60,10,9*60,70),true,'original start included');
 assert.equal(allowed(10*60+20,10,9*60,70),false,'after end excluded');
 assert.equal(allowed(8*60+50,30,9*60,70),false,'earlier but overlapping is excluded');
 assert.equal(allowed(0,10,23*60+50,10),true,'midnight original end included');
 assert.equal(allowed(10,10,23*60+50,10),false,'beyond overnight end excluded');
 assert.match(ui,/\[selected,selected\+1440\]\.some\(candidate/);
 assert.match(ui,/candidate >= originalStart && candidate <= originalEnd/);
 assert.match(ui,/if \(isPhone && !overlapping\(\)\)/);
 const migration=read('supabase/migrations/20261122163500_walkin_original_window_inclusive.sql');
 assert.match(migration,/v_candidate > /);
 assert.match(migration,/v_candidate < /);
 assert.match(migration,/WALKIN_ADMIN_ROUTER_CONTRACT_CHANGED/);
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
