const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('frontdesk physical PostgreSQL races and rollback tests are in the mandatory CI lane',()=>{
 const workflow=fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/test-memberwebsocket-dev.yml'),'utf8');
 const lane=workflow.split('\n  postgres-integration:')[1].split('\n  edge-functions:')[0];
 assert.ok(lane.includes('MemberWebsocket-dev/tests/integration/postgres/frontdesk-access.cjs'));
 assert.ok(workflow.includes('POSTGRES_INTEGRATION: ${{ needs.postgres-integration.result }}'));
});
test('frontdesk staff and service-role RPCs never expose direct anonymous access',()=>{
 const migration=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261118122150_frontdesk_booking_access.sql'),'utf8');
 assert.match(migration,/alter table platform_private\.frontdesk_staff enable row level security;/);
 assert.match(migration,/revoke all on platform_private\.frontdesk_staff from public,anon,authenticated;/);
 assert.match(migration,/public\.platform_frontdesk_request\(uuid,text,text,timestamptz,text,jsonb\)[\s\S]*?from public,anon,authenticated;/);
 assert.match(migration,/public\.platform_frontdesk_delivery\(uuid,text\)[\s\S]*?from public,anon,authenticated;/);
});

test('AC-FD-021: hosted safeupdate must never reject recipient projection on registration or approval',()=>{
 const migration=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261118190000_frontdesk_safeupdate_projection.sql'),'utf8');
 assert.match(migration,/create or replace function public\.platform_frontdesk_admin/);
 assert.match(migration,/delete from %I\.frontdesk_notice_recipients r where not exists/);
 assert.match(migration,/delete from %I\.frontdesk_notice_recipients where line_user_id is not null/);
 assert.match(migration,/select distinct line_user_id from platform_private\.frontdesk_staff/);
 assert.match(migration,/on conflict \(line_user_id\) do nothing/);
 assert.doesNotMatch(migration,/delete from %I\.frontdesk_notice_recipients'[,)]/);
});
