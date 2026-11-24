const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.resolve(__dirname,'..',p),'utf8');

test('AC-FMR-001/002: ordinary and modification rejection buckets are independent',async()=>{
 const {defaultRejectionSettings,normalizeRejectionSettings,validateRejectionSettingsUpdate,resolveRejectionReason}=await import('../supabase/functions/_shared/frontdesk-rejection-settings.mjs');
 const original=defaultRejectionSettings();
 const id='custom_12345678-1234-4123-8123-123456789abc';
 const modified=validateRejectionSettingsUpdate(original,{
   ...original,modification:{dropdownTitle:'拒絕修改理由',reasons:[
     {id,label:'修改後無法安排',memberDescription:'請重新調整修改時間。',enabled:true,requiresConflictTime:false,hasVacationTechnicians:false}
   ]}
 });
 assert.equal(modified.reasons.length,2,'new-booking reasons must survive separate modification changes');
 assert.equal(modified.modification.reasons.length,1);
 assert.equal(modified.modification.dropdownTitle,'拒絕修改理由');
 assert.equal(resolveRejectionReason(modified,id,'booking.update','modification').label,'修改後無法安排');
 assert.throws(()=>resolveRejectionReason(modified,id,'booking.update','new'),/BOOKING_REJECTION_REASON_REQUIRED/);
 assert.throws(()=>resolveRejectionReason(modified,'technician_leave','booking.update','modification'),/BOOKING_REJECTION_REASON_REQUIRED/);
 assert.equal(resolveRejectionReason(modified,'technician_leave','booking.update','new').id,'technician_leave');
 assert.equal(normalizeRejectionSettings({dropdownTitle:original.dropdownTitle,reasons:original.reasons}).modification.reasons.length,1,
   'legacy merchants receive usable default modification reasons');
 modified.modification.reasons[0].memberDescription='新版本';
 assert.equal(original.modification.reasons[0].memberDescription,'修改後的預約時間無法安排，請重新選擇其他時段。');
});

test('AC-FMR-003: malformed modification policies are rejected, empty saved list is allowed',async()=>{
 const {defaultRejectionSettings,normalizeRejectionSettings}=await import('../supabase/functions/_shared/frontdesk-rejection-settings.mjs');
 const base=defaultRejectionSettings();
 for(const modification of [null,{reasons:[]},{dropdownTitle:'',reasons:[{id:'bad'}]},
   {dropdownTitle:'正確',reasons:[],modification:base.modification},
   {dropdownTitle:'正確',reasons:[{...base.modification.reasons[0],enabled:'true'}]},
   {...base.modification,reasons:[base.modification.reasons[0],base.modification.reasons[0]]}
 ]){
   assert.throws(()=>normalizeRejectionSettings({...base,modification}),TypeError);
 }
 const empty=normalizeRejectionSettings({...base,modification:{dropdownTitle:'',reasons:[]}});
 assert.equal(empty.modification.dropdownTitle,'請選擇拒絕修改原因');
 assert.deepEqual(empty.modification.reasons,[]);
});

test('AC-FMR-004: frontdesk never trusts a client supplied review kind or cross-bucket reason',()=>{
 const sql=read('supabase/migrations/20261124233000_frontdesk_modification_review_and_rejection_reasons.sql');
 const handler=read('supabase/functions/_shared/frontdesk-handler.mjs');
 const ui=read('frontdesk/app.js');
 assert.match(sql,/function platform_private\.frontdesk_review_kind/);
 assert.match(sql,/actor_role='member' and e\.action='BOOKING_UPDATED'/);
 assert.match(sql,/v_edit>v_review/,'only a newer member edit is a pending modification');
 assert.match(sql,/v_review_kind:=platform_private\.frontdesk_review_kind\(t\.runtime_schema,bid,''pending''\)/);
 assert.match(sql,/'reviewKind'',v_review_kind/,'review kind must be a trusted audit snapshot');
 assert.match(sql,/v_policy->'modification'->'reasons'/);
 assert.match(sql,/v_review_kind text/);
 assert.match(sql,/FRONTDESK_MODIFICATION_REJECTION_ROUTE_DRIFT/);
 assert.match(sql,/BUSINESS_SCHEMA_INVALID/);
 assert.match(sql,/revoke all on function platform_private\.frontdesk_review_kind.*from public,anon,authenticated/i);
 assert.match(handler,/platform_frontdesk_rejection_request/);
 assert.doesNotMatch(handler,/reviewKind:body\./);
 assert.match(ui,/booking\?\.reviewKind==='modification'/);
 assert.match(ui,/rejectionSettingsFor\(booking\)/);
 assert.match(ui,/確認修改預約/);
 assert.match(ui,/拒絕修改預約/);
});

test('AC-FMR-005: admin split-reason editor saves both buckets with one authorized version check',()=>{
 const admin=read('admin/frontdesk-settings.js');
 const sql=read('supabase/migrations/20261124233000_frontdesk_modification_review_and_rejection_reasons.sql');
 assert.match(admin,/拒絕修改預約/);
 assert.match(admin,/新增拒絕修改原因/);
 assert.match(admin,/modification: \{dropdownTitle:modTitle\.input\.value\.trim\(\)/);
 assert.match(admin,/platform\.frontdesk\.rejection-settings\.save/);
 assert.match(sql,/platform_private\.validate_frontdesk_rejection_settings\(/);
 assert.match(sql,/p_next->'modification'/);
 assert.match(sql,/version=version\+1/);
 assert.match(sql,/business_templates/,'future merchant notice template must be patched');
 assert.doesNotMatch(sql,/grant execute on function platform_private\.frontdesk_review_kind.*to (anon|authenticated)/i);
});

test('AC-FMR-006/007: member and admin LINE titles reflect only an audited frontdesk decision',()=>{
 const sql=read('supabase/migrations/20261124233000_frontdesk_modification_review_and_rejection_reasons.sql');
 const delivery=read('supabase/functions/booking-line-notifications/delivery.ts');
 for(const title of ['櫃檯確認修改','櫃檯拒絕修改','確認修改預約','拒絕修改預約'])assert.ok(sql.includes(title),title);
 assert.match(sql,/e\.actor_role=''frontdesk''/);
 assert.match(sql,/e\.metadata->>''reviewKind''/);
 assert.match(sql,/platform_private\.frontdesk_review_kind\(TG_TABLE_SCHEMA,NEW\.id,''confirmed''\)/);
 assert.match(sql,/platform_private\.frontdesk_review_kind\(TG_TABLE_SCHEMA,NEW\.id,''rejected''\)/);
 for(const title of ['櫃檯確認修改','櫃檯拒絕修改','確認修改預約','拒絕修改預約'])assert.ok(delivery.includes(title),title);
 assert.match(delivery,/frontdeskRejectionCards\(visibleText\)/);
 assert.match(delivery,/memberConfirmation \|\| memberReminder/,'confirm modifications must retain member participant cards');
});
