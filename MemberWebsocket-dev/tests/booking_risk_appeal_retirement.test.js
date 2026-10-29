const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const read=p=>fs.readFileSync('MemberWebsocket-dev/'+p,'utf8');
test('AC-RISK-RETIRE-001 no member or admin appeal controls',()=>{
 const admin=read('admin/booking-risk.js'),member=read('booking/app.js');
 for(const term of ['會員申覆','記錄回覆','appeal_enabled'])assert.equal(admin.includes(term),false,term);
 assert.doesNotMatch(member,/user\.booking\.risk\.appeal|提出申覆|申覆已送出/);
 assert.match(admin,/人工解除/);assert.match(admin,/撤銷誤判/);
});
test('AC-RISK-RETIRE-002 API rejects removed dispatch and retains restriction and release',()=>{
 const api=read('supabase/functions/booking-api/index.ts');
 assert.doesNotMatch(api,/user\.booking\.risk\.appeal|admin\.booking\.risk\.resolve|booking_no_show_appeal/);
 assert.match(api,/booking_no_show_status/);assert.match(api,/admin\.booking\.risk\.release/);
});
test('AC-RISK-RETIRE-003 migration archives old records and removes mutation path',()=>{
 const migration=read('supabase/migrations/20261029125700_retire_booking_risk_appeals.sql');
 assert.match(migration,/drop function if exists %I\.booking_no_show_appeal/);
 assert.match(migration,/appeal_enabled=false/);
 assert.match(migration,/to_jsonb\(p\) - ''appeal_enabled''/);
 assert.doesNotMatch(migration,/drop table|truncate|delete from.*booking_restriction_appeals/i);
});
