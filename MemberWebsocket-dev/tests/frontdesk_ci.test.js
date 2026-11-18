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
