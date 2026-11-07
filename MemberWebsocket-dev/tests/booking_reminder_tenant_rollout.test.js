const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const sql=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261031095500_business_booking_reminder_rollout.sql'),'utf8');

test('AC-010: each isolated business schema gains booking-level reminder columns with safe one-time legacy backfill',()=>{
 assert.match(sql,/p_schema !~ '\^business_\[0-9a-f\]\{32\}\$'/);
 assert.match(sql,/platform_private\.tenants t where t\.runtime_schema = p_schema/);
 assert.match(sql,/add column if not exists reminder_enabled boolean not null default false/);
 assert.match(sql,/add column if not exists reminder_time time without time zone not null default time/);
 assert.match(sql,/if v_new then[\s\S]*?reminder_enabled=s\.reminder_enabled/);
 assert.match(sql,/if not exists \(\s*select 1 from pg_catalog\.pg_constraint/);
});

test('AC-011: existing root adapters are installed into tenant schemas with least privilege',()=>{
 for(const name of [
  'create_booking_bundle_with_benefits_reminder',
  'update_booking_bundle_with_benefits_reminder',
  'create_booking_bundle_with_contact_reminder',
  'update_booking_bundle_with_contact_reminder',
  'create_group_booking_with_benefits_reminder_v2',
  'update_group_booking_with_benefits_reminder_v2',
  'create_friend_booking_with_reminder',
 ]) assert.ok(sql.includes("'"+name+"'"),name);
 assert.match(sql,/replace\(pg_catalog\.pg_get_functiondef\(v_fn\.oid\), 'public\.'/);
 assert.match(sql,/revoke all on function %I\.%I\(%s\) from public,anon,authenticated/);
 assert.match(sql,/grant execute on function %I\.%I\(%s\) to service_role/);
});

test('AC-012: per-tenant outbox sync and dispatch guard use tenant consent, not shared setting',()=>{
 assert.match(sql,/notice_sync_day_before_reminders/);
 assert.match(sql,/booking_notifications\.outbox',format\('%I\.notice_outbox'/);
 assert.match(sql,/booking_notifications\.config',format\('%I\.notice_config'/);
 assert.match(sql,/skip_invalid_booking_reminder/);
 assert.match(sql,/pg_get_functiondef\(v_sync\)/);
 assert.match(sql,/pg_get_functiondef\(v_guard\)/);
});

test('AC-013: new tenants get installer and no other provisioning hooks are removed',()=>{
 assert.match(sql,/platform_provision_business_base_20261028_invitation/);
 assert.match(sql,/platform_private\.install_member_invitations\(v_schema\)/);
 assert.match(sql,/platform_private\.install_booking_reminder\(v_schema\)/);
 assert.match(sql,/for v in select runtime_schema from platform_private\.tenants/);
});

test('AC-014: booking-only scheduled tick respects booking feature grants and avoids broad platform job',()=>{
 assert.match(sql,/create or replace function public\.platform_tick_booking_reminders/);
 assert.match(sql,/features->>'booking'='true'/);
 assert.match(sql,/notice_sync_day_before_reminders\(\)/);
 assert.match(sql,/public\.platform_dispatch_booking\(t\.id\)/);
 assert.match(sql,/cron\.schedule\('platform-booking-reminders'/);
 assert.doesNotMatch(sql,/cron\.alter_job\([^)]*14|platform_tick_businesses\(/);
});
