const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');
const migration = read('supabase/migrations/20261122183000_admin_rejection_frontdesk_line_scope.sql');
const frontend = read('frontdesk/app.js');

test('AC-ADM-FD-001: admin paired suppression is audit-proven, tenant-scoped and leaves member/frontdesk-admin routes intact',()=>{
 assert.match(migration,/create or replace function platform_private\.admin_paired_walkin_source/);
 assert.match(migration,/runtime_schema=p_schema/);
 assert.match(migration,/rejected\.action='BOOKING_REJECTED'/);
 assert.match(migration,/rejected\.actor_role='admin'/);
 assert.match(migration,/replacement\.action='BOOKING_PHONE_CREATED'/);
 assert.match(migration,/replacement\.actor_role='admin'/);
 assert.match(migration,/replacement\.actor_line_user_id=rejected\.actor_line_user_id/);
 assert.match(migration,/replacement\.created_at=rejected\.created_at/);
 assert.match(migration,/original\.rejected_at=rejected\.created_at/);
 assert.match(migration,/rejection_reason='unrecorded_phone_booking'/);
 assert.match(migration,/platform_private\.frontdesk_paired_phone_source\(TG_TABLE_SCHEMA,to_jsonb\(NEW\)\)/);
 assert.match(migration,/or platform_private\.admin_paired_walkin_source\(TG_TABLE_SCHEMA,to_jsonb\(NEW\)\)/);
 assert.match(migration,/business_templates/);
 assert.match(migration,/ADMIN_WALKIN_FRONTDESK_NOTICE_SUPPRESSED/);
 assert.match(migration,/o\.attempt_count=0 and o\.first_attempt_at is null/);
 assert.doesNotMatch(migration,/delete\s+from\s+.*notice_outbox/i);
 assert.doesNotMatch(migration,/grant execute on function platform_private\.admin_paired_walkin_source.*to (?:anon|authenticated)/is);
});

test('AC-ADM-FD-002: admin history is single-booking only; staff-wide history stays actor-bound, paired audits match',()=>{
 assert.match(migration,/actor_role=''admin'' and \$3::uuid is not null/);
 assert.match(migration,/actor_role=''frontdesk'' and actor_line_user_id=\$2/);
 assert.match(migration,/and \(\$3::uuid/);
 assert.match(migration,/paired\.actor_role=e\.actor_role/);
 assert.match(migration,/b\.rejected_by=e\.actor_line_user_id/);
 assert.match(migration,/b\.rejection_reason=''unrecorded_phone_booking''/);
 assert.match(migration,/''actorRole'',e\.actor_role/);
 assert.match(read('supabase/migrations/20261122133000_frontdesk_history_booking_scope.sql'),/and paired\.actor_line_user_id=e\.actor_line_user_id/);
 assert.match(frontend,/const visible=bookingId\?records\.filter/);
 assert.match(frontend,/if\(bookingId&&!historyLoaded\)\{historyLoaded=true;void loadConflictHistory\(\);\}/);
 assert.match(frontend,/historyLoaded=false;clearPrivateHistory\(\)/);
});

test('AC-ADM-FD-007: admin-paired notification uses trusted paired audit time, not transaction-stable booking creation clock',()=>{
 const repaired=read('supabase/migrations/20261122190000_admin_walkin_notification_clock_fix.sql');
 assert.match(repaired,/create or replace function platform_private\.admin_paired_walkin_source/);
 assert.match(repaired,/rejected\.actor_line_user_id=original\.rejected_by/);
 assert.match(repaired,/replacement\.actor_line_user_id=rejected\.actor_line_user_id/);
 assert.match(repaired,/replacement\.created_at=rejected\.created_at/);
 assert.match(repaired,/original\.rejected_at=rejected\.created_at/);
 assert.match(repaired,/original\.booking_date=\$3/);
 assert.match(repaired,/original\.rejection_reason='unrecorded_phone_booking'/);
 assert.doesNotMatch(repaired,/original\.rejected_at<=\$4/,'now() booking creation time must not be used for clock_timestamp() audit pairing');
 assert.doesNotMatch(repaired, /p_booking->>'created_at'/,'created_at from a booking may predate its rejection audit within the same transaction');
 assert.match(repaired,/o\.event_key=b\.id::text\|\|':created'/);
 assert.match(repaired,/o\.status='pending' and o\.attempt_count=0 and o\.first_attempt_at is null/);
 assert.match(repaired,/platform_private\.admin_paired_walkin_source\(%2\$L,to_jsonb\(b\)\)/);
 assert.doesNotMatch(repaired,/grant execute on function platform_private\.admin_paired_walkin_source.*to (?:anon|authenticated)/is);
});
