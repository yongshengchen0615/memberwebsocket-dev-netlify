const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const ui=read('admin/booking-panel-core.js');
const api=read('supabase/functions/booking-api/index.ts');
const runtime=read('supabase/functions/_shared/business-runtime.ts');
const sqlPath='supabase/migrations/20261128181500_admin_booking_vacation_technicians.sql';

test('AC-001: admin rejection offers only booked non-primary technicians, 1–10 checked',()=>{
 assert.match(ui,/data-admin-vacation-technicians/);
 assert.match(ui,/state\.booking\.groups\[booking\.bookingId\]/);
 assert.match(ui,/isPrimaryTechnician/);
 assert.match(ui,/primaryTechnicianId/);
 assert.match(ui,/selectedVacationIds/);
 assert.match(ui,/最多可勾選 10 位/);
 assert.match(ui,/請至少勾選一位休假技師/);
});
test('AC-002: admin uses vacation RPC and previews canonical member message with original booking time',()=>{
 assert.match(ui,/admin\.booking\.reject-vacation/);
 assert.match(ui,/vacationTechnicianIds/);
 assert.match(ui,/目前預約時間：/);
 assert.match(ui,/技師休假。/);
 assert.match(api,/async function adminRejectVacation\(/);
 assert.match(api,/platform_admin_reject_vacation/);
 assert.match(api,/vacationTechnicianIds/);
});
test('AC-003: verified admin route is tenant-scoped; backend never trusts client description',()=>{
 assert.match(runtime,/if\(name==='platform_admin_reject_vacation'\)/);
 assert.match(runtime,/current\.verifiedAdmin/);
 assert.match(runtime,/p_tenant_id:current\.id/);
 const sql=read(sqlPath);
 assert.match(sql,/p_actor is distinct from t\.owner_line_user_id/);
 assert.match(sql,/t\.features->>'booking' is distinct from 'true'/);
 assert.match(sql,/t\.access_revoked_before/);
 const candidates=read('supabase/migrations/20261124162000_frontdesk_booking_only_vacation_candidates.sql');
 assert.match(candidates,/booking_participants/);
 assert.match(candidates,/primary_technician_id/);
 assert.match(sql,/frontdesk_booked_vacation_names/);
 assert.match(sql,/frontdesk_vacation_member_description/);
 assert.match(sql,/VACATION_TECHNICIANS_INVALID/);
 assert.doesNotMatch(sql,/p_body->>'rejectionMemberDescription'/);
 assert.doesNotMatch(sql,/grant execute on function public\.platform_admin_reject_vacation[^;]+to (?:anon|authenticated)/i);
});
test('AC-004: rejection, immutable member reason, audit and exact idempotent replay share one transaction',()=>{
 const sql=read(sqlPath);
 assert.match(sql,/for update/);
 assert.match(sql,/BOOKING_CONFLICT/);
 assert.match(sql,/BOOKING_CANCELLATION_PENDING/);
 assert.match(sql,/rejection_member_description/);
 assert.match(sql,/booking_audit_events/);
 assert.match(sql,/pg_advisory_xact_lock/);
 assert.match(sql,/platform_private\.requests/);
 assert.match(sql,/payload_hash/);
 assert.match(sql,/alreadyApplied/);
 assert.match(api,/BOOKING_REJECTION_REASON_REQUIRED/);
 assert.match(api,/ADMIN_WALKIN_DETAILS_REQUIRED/);
});
