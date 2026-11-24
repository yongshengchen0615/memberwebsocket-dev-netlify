const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=pathName=>fs.readFileSync(path.join(__dirname,'..',pathName),'utf8');
const reasons=['technician_leave','unrecorded_phone_booking'];

test('AC-FR-001: both reviewer UIs require one of the fixed rejection reasons',()=>{
 const frontdesk=read('frontdesk/app.js');
 const admin=read('admin/booking-panel-core.js');
 for(const source of [frontdesk,admin]){
  for(const code of reasons)assert.ok(source.includes(code),code);
  assert.match(source,/預約中有休假技師/);
  assert.match(source,/該時段已被現場人員預約但未登記/);
  assert.match(source,/請先選擇拒絕原因/);
 }
});
test('AC-FR-002: admin API validates and stores reason; settings are version-guarded',()=>{
 const booking=read('supabase/functions/booking-api/index.ts');
 const settings=read('supabase/functions/booking-admin-api/index.ts');
 assert.match(booking,/BOOKING_REJECTION_REASON_REQUIRED/);
 assert.match(booking,/patch\.rejection_reason\s*=\s*rejectionReason/);
 assert.match(settings,/admin\.booking\.rejection-message\.save/);
 assert.match(settings,/BOOKING_REJECTION_MESSAGE_UPDATED/);
 assert.match(settings,/\.eq\('updated_at',expectedUpdatedAt\)/);
});
test('AC-FR-003: tenant migration retains booking outbox and explicit access checks',()=>{
 const sql=read('supabase/migrations/20261120223000_booking_rejection_reason_notices.sql');
 const rpc=read('supabase/migrations/20261120223100_frontdesk_rejection_admin_alert.sql');
 assert.match(sql,/bookings_zz_append_rejection_notice/);
 assert.match(sql,/NEW\.status<>'rejected'/);
 assert.match(sql,/o\.channel='member' and o\.status='pending'/);
 assert.match(sql,/BOOKING_REJECTION_SCHEMA_INVALID/);
 assert.match(rpc,/FRONTDESK_RPC_HASH_CONTRACT_CHANGED/);
 assert.match(rpc,/FRONTDESK_RPC_UPDATE_CONTRACT_CHANGED/);
 assert.match(rpc,/BOOKING_REJECTION_REASON_REQUIRED/);
 assert.match(rpc,/frontdesk\.rejected:/);
 assert.match(rpc,/actor_role=''frontdesk''/);
 assert.match(rpc,/on conflict\(event_key,channel,recipient\) do nothing/);
});
test('AC-FR-004: frontdesk rejects missing or forged reasons before database writes',async()=>{
 const {createFrontdeskHandler}=await import('../supabase/functions/_shared/frontdesk-handler.mjs');
 const actor='U'+'a'.repeat(32),calls=[];
 const context={id:'10000000-0000-4000-8000-000000000001',slug:'shop-a',name:'A',frontdesk:{enabled:true,loginChannelId:'2010999999'}};
 const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name==='platform_frontdesk_context'?context:name==='consume_api_rate_limit'?true:{ok:true},error:null};}};
 const handler=createFrontdeskHandler({db,allowedOrigins:new Set(['https://allowed.test']),verifyIdentity:async()=>({lineUserId:actor,issuedAtMs:Date.now()})});
 const common={action:'frontdesk.booking.update',business:'shop-a',idToken:'valid',
  bookingId:'10000000-0000-4000-8000-000000000003',
  requestId:'10000000-0000-4000-8000-000000000004',
  expectedUpdatedAt:'2026-11-20T09:00:00.000Z',status:'rejected'};
 const request=async body=>{const res=await handler(new Request('https://api.test',{method:'POST',
  headers:{Origin:'https://allowed.test'},body:JSON.stringify({...common,...body})}));return {status:res.status,data:await res.json()};};
 assert.equal((await request({})).status,400);
 assert.equal((await request({rejectionReason:'forged'})).status,400);
 assert.equal(calls.filter(c=>c.name==='platform_frontdesk_rejection_request').length,0);
 assert.equal((await request({rejectionReason:reasons[0]})).status,200);
 const actual=calls.find(c=>c.name==='platform_frontdesk_rejection_request').args.p_body;
 assert.equal(actual.rejectionReason,reasons[0]);
 assert.equal(actual.status,'rejected');
});

test('AC-FR-005: phone requests are tenant-scoped, pending, slot-blocking and audited',()=>{
 const api=read('supabase/functions/_shared/frontdesk-handler.mjs');
 const ui=read('frontdesk/app.js');
 const migration=read('supabase/migrations/20261120224500_frontdesk_phone_pending.sql');
 const provision=read('supabase/migrations/20261120224600_frontdesk_phone_provisioning.sql');
 for(const op of ['frontdesk.phone.catalog','frontdesk.phone.slots','frontdesk.phone.create'])assert.ok(api.includes(op),op);
 assert.match(api,/frontdesk\.phone\.create'.*includes\(body\.action\)/);
 assert.match(ui,/登記電話／現場預約/);
 assert.match(ui,/原預約已拒絕，電話／現場預約已登記並直接確認/);
 assert.match(ui,/openRejectionDialog/);
 assert.match(ui,/衝突預約總時長（每 10 分鐘）/);
 assert.doesNotMatch(ui,/frontdesk-phone-service-option/);
 assert.match(ui,/frontdeskLockPrevious/);
 assert.match(migration,/admin_create_phone_booking_request/);
 assert.match(migration,/frontdesk_create_phone_booking_request/);
 assert.match(migration,/v_total,''pending''/);
 assert.match(migration,/v_saved\.confirmed_by is distinct from p_actor/);
 assert.match(migration,/p_actor,''frontdesk'',''BOOKING_PHONE_CREATED''/);
 assert.match(migration,/status in \(''pending'',''confirmed''\)/);
 assert.match(migration,/platform_private\.frontdesk_staff/);
 assert.match(migration,/booking_slot_fits/);
 assert.match(migration,/booking_slot_start_at/);
 assert.match(provision,/install_frontdesk_phone/);
});
test('AC-FR-006: malformed frontdesk phone writes fail before a tenant RPC, valid writes keep the authenticated actor',async()=>{
 const {createFrontdeskHandler}=await import('../supabase/functions/_shared/frontdesk-handler.mjs');
 const user='U'+'a'.repeat(32),calls=[];
 const context={id:'10000000-0000-4000-8000-000000000001',slug:'shop-a',name:'A',frontdesk:{enabled:true,loginChannelId:'2010999999'}};
 const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name==='platform_frontdesk_context'?context:name==='consume_api_rate_limit'?true:{status:'pending'},error:null};}};
 const handler=createFrontdeskHandler({db,allowedOrigins:new Set(['https://allowed.test']),verifyIdentity:async()=>({lineUserId:user,issuedAtMs:Date.now()})});
 const request=async b=>{const res=await handler(new Request('https://api.test',{method:'POST',headers:{Origin:'https://allowed.test'},
  body:JSON.stringify({business:'shop-a',idToken:'valid',...b})}));return {status:res.status,data:await res.json()};};
 const payload={action:'frontdesk.phone.create',requestId:'PHONE-10000000-0000-4000-8000-000000000099',
  bookingDate:'2026-12-12',startTime:'10:00',contactSurname:'QA',contactSalutation:'mr',
  items:[{serviceId:'10000000-0000-4000-8000-000000000003',quantity:1}]};
 assert.equal((await request({...payload,items:[]})).status,400);
 assert.equal((await request({...payload,requestId:'FORGED'})).status,400);
 assert.equal((await request({...payload,items:[{...payload.items[0],quantity:0}]})).status,400);
 assert.equal(calls.filter(x=>x.name==='platform_frontdesk_request').length,0);
 assert.equal((await request(payload)).status,200);
 const applied=calls.filter(x=>x.name==='platform_frontdesk_request').at(-1).args;
 assert.equal(applied.p_actor,user);
 assert.equal(applied.p_action,'phone.create');
 assert.deepEqual(applied.p_body.items,payload.items);
 assert.equal(applied.p_body.requestId,payload.requestId);
});

test('AC-FR-MODAL-005: paired rejection is authorized, atomic, date derived server-side, and dispatched once',async()=>{
 const api=read('supabase/functions/_shared/frontdesk-handler.mjs');
 const migration=read('supabase/migrations/20261120235900_frontdesk_atomic_reject_phone.sql');
 assert.match(api,/frontdesk\.booking\.reject-phone/);
 assert.match(api,/body\.bookingDate!==undefined/);
 assert.match(api,/body\.contactSurname!==undefined/);
 assert.match(api,/body\.phoneRequestId/);
 assert.match(migration,/public\.platform_frontdesk_request\(p_tenant_id,p_actor,p_channel_id,p_issued_at,'booking\.update',p_body\)/);
 assert.match(migration,/frontdesk_create_phone_booking_request/);
 assert.match(migration,/\(b->>'booking_date'\)::date/);
 assert.match(migration,/phoneBookingStatus/);
 const {createFrontdeskHandler}=await import('../supabase/functions/_shared/frontdesk-handler.mjs');
 const actor='U'+'a'.repeat(32),calls=[],tenantId='10000000-0000-4000-8000-000000000001';
 const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name==='platform_frontdesk_context'?{id:tenantId,slug:'shop-a',name:'Shop',frontdesk:{enabled:true,loginChannelId:'2010999999'}}:name==='consume_api_rate_limit'?true:{phoneBookingStatus:'pending'},error:null};}};
 const handler=createFrontdeskHandler({db,allowedOrigins:new Set(['https://allowed.test']),verifyIdentity:async()=>({lineUserId:actor,issuedAtMs:Date.now()})});
 const payload={action:'frontdesk.booking.reject-phone',business:'shop-a',idToken:'valid',bookingId:'10000000-0000-4000-8000-000000000003',requestId:'10000000-0000-4000-8000-000000000004',phoneRequestId:'PHONE-10000000-0000-4000-8000-000000000005',expectedUpdatedAt:'2026-11-20T10:00:00Z',status:'rejected',rejectionReason:'unrecorded_phone_booking',startTime:'11:00',totalDurationMinutes:90};
 const send=async body=>{const res=await handler(new Request('https://api.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify(body)}));return res.status;};
 assert.equal(await send({...payload,bookingDate:'2026-12-01'}),400);
 assert.equal(await send({...payload,items:[{serviceId:'10000000-0000-4000-8000-000000000006',quantity:1}]}),400);
 assert.equal(await send({...payload,totalDurationMinutes:0}),400);
 assert.equal(await send({...payload,totalDurationMinutes:1440}),400);
 assert.equal(await send({...payload,totalDurationMinutes:1.5}),400);
 assert.equal(await send({...payload,phoneRequestId:'BAD'}),400);
 assert.equal(calls.filter(c=>c.name==='platform_frontdesk_rejection_request').length,0);
 assert.equal(await send(payload),200);
 const routed=calls.find(c=>c.name==='platform_frontdesk_rejection_request');
 assert.equal(routed.args.p_action,'booking.reject_phone');
 assert.equal(routed.args.p_actor,actor);
 assert.equal(routed.args.p_body.totalDurationMinutes,90);
 assert.equal(Object.hasOwn(routed.args.p_body,'items'),false);
 assert.equal(Object.hasOwn(routed.args.p_body,'bookingDate'),false);
 assert.equal(calls.filter(c=>c.name==='platform_dispatch_booking').length,1);
});

test('AC-001..004: paired frontdesk rejection produces one admin notice and suppresses replacement enqueue',()=>{
 const sql=read('supabase/migrations/20261121120000_frontdesk_rejection_line_details.sql');
 assert.match(sql,/frontdesk_paired_phone_source/);
 assert.match(sql,/BOOKING_PHONE_CREATED/);
 assert.match(sql,/BOOKING_REJECTED/);
 assert.match(sql,/actor_role='frontdesk'/);
 assert.match(sql,/original\.status='rejected'/);
 assert.match(sql,/original\.rejection_reason='unrecorded_phone_booking'/);
 assert.match(sql,/v_phone_id is null/);
 assert.match(sql,/【原預約資料】/);
 assert.match(sql,/【櫃檯新增的預約資料】/);
 assert.match(sql,/預約人：櫃檯人員/);
 assert.match(sql,/if v_frontdesk then/);
 assert.match(sql,/frontdesk_paired_phone_source\(TG_TABLE_SCHEMA,to_jsonb\(NEW\)\)/);
 assert.match(sql,/then return null;end if;/);
 assert.match(sql,/install_booking_rejection\(text\)/);
 assert.doesNotMatch(sql,/delete from .*notice_outbox/i);
});

test('AC-FR-007: paired walk-in is confirmed atomically and shown as frontdesk staff',()=>{
 const sql=read('supabase/migrations/20261121134000_frontdesk_paired_immediate_confirmation.sql');
 const ui=read('frontdesk/app.js');
 assert.match(sql,/coalesce\(\(v->>'alreadyApplied'\)::boolean,false\)/);
 assert.match(sql,/frontdesk_paired_phone_source\(t\.runtime_schema,b\)/);
 assert.match(sql,/v->>'alreadyApplied'/);
 assert.match(sql,/update %I\.bookings x set status=''confirmed''/);
 assert.match(sql,/confirmed_by=\$2,confirmed_at=clock_timestamp\(\)/);
 assert.match(sql,/contact_surname=''櫃檯人員'',contact_salutation=null/);
 assert.match(sql,/where x\.id=\$1 and x\.status=''pending'' returning to_jsonb\(x\)/);
 assert.match(sql,/FRONTDESK_PHONE_CONFIRM_CONFLICT/);
 assert.match(sql,/b\.status in \(''pending'',''confirmed''\)/);
 assert.match(sql,/v_phone->>'status'='confirmed' then '已確認'/);
 assert.match(sql,/預約人：櫃檯人員/);
 assert.match(sql,/FRONTDESK_PAIRED_CONFIRM_ROUTER_CONTRACT_CHANGED/);
 assert.match(ui,/無須等待管理員審核/);
 assert.match(ui,/電話／現場預約已登記並直接確認/);
 assert.doesNotMatch(ui,/登記後等待管理員確認/);
});

test('AC-FR-008: pairing uses same-transaction audited actor instead of mismatched clock values',()=>{
 const sql=read('supabase/migrations/20261121134500_frontdesk_paired_audit_timestamp.sql');
 assert.match(sql,/reject_audit\.created_at=phone_audit\.created_at/);
 assert.match(sql,/reject_audit\.actor_line_user_id=phone_audit\.actor_line_user_id/);
 assert.match(sql,/phone_audit\.action='BOOKING_PHONE_CREATED'/);
 assert.match(sql,/reject_audit\.action='BOOKING_REJECTED'/);
 assert.match(sql,/original\.rejection_reason='unrecorded_phone_booking'/);
 assert.match(sql,/original\.status='rejected'/);
 assert.doesNotMatch(sql,/original\.rejected_at\s*<=\s*\$4/);
 assert.match(sql,/p_booking->>'booking_date'/);
});

test('AC-FR-009: active confirmed replacement retains same-auditor pair; admin rejection uses canonical event key',()=>{
 const sql=read('supabase/migrations/20261121151000_frontdesk_rejection_notice_repair.sql');
 assert.match(sql,/not in \('pending','confirmed'\)/);
 assert.match(sql,/frontdesk_paired_phone_source/);
 assert.match(sql,/old_key constant text/);
 assert.match(sql,/frontdesk\.rejected:/);
 assert.match(sql,/new_key constant text := \$new\$v_event\$new\$/);
 assert.match(sql,/using NEW\.id,v_event,left\(v_admin_message/);
 assert.match(sql,/FRONTDESK_REJECTION_NOTICE_CONTRACT_CHANGED/);
 assert.doesNotMatch(sql,/update\s+.*notice_outbox.*status\s*=\s*'accepted'/i);
});
test('AC-FR-010: administration only treats audit-proven paired booking as frontdesk',()=>{
 const api=read('supabase/functions/booking-api/index.ts');
 const ui=read('admin/booking-panel-core.js');
 assert.match(api,/async function verifiedFrontdeskReplacements/);
 assert.match(api,/BOOKING_PHONE_CREATED/);
 assert.match(api,/BOOKING_REJECTED/);
 assert.match(api,/original\.status !== "rejected"/);
 assert.match(api,/original\.rejection_reason !== "unrecorded_phone_booking"/);
 assert.match(api,/created\.created_at === rejected\.created_at/);
 assert.match(api,/created\.actor_line_user_id === rejected\.actor_line_user_id/);
 assert.match(api,/frontdeskReplacement, \/\/ Verified from paired frontdesk audit events/);
 assert.match(ui,/booking\.frontdeskReplacement === true/);
 assert.match(ui,/預約來源', isFrontdeskReplacement\(booking\) \? '櫃檯人員'/);
 assert.match(ui,/if \(!isFrontdeskReplacement\(booking\)\)/);
 assert.match(ui,/card\.dataset\.bookingFrontdeskReplacement = String\(isFrontdeskReplacement\(booking\)\)/);
 assert.match(ui,/isFrontdeskReplacement\(booking\) \? '' : String\(booking\.contactPhone/);
 assert.match(ui,/if \(isPhoneBooking\(booking\) && !isFrontdeskReplacement\(booking\)\)/);
});
test('AC-FR-011: staff replacement clipboard omits phantom contact fields, ordinary copies retain them',()=>{
 const vm=require('node:vm');
 const ctx={};
 vm.runInNewContext(read('booking-copy-text.js'),ctx);
 const data={bookingDate:'2026-12-01',startTime:'09:00',name:'王先生',phone:'0900000000',
  participants:[{items:[{serviceTitle:'身體60',quantity:1}],technicianName:'10技師'}]};
 const special=ctx.BookingCopyText.formatClipboard({...data,omitContact:true});
 assert.match(special,/預約來源：櫃檯人員/);
 assert.match(special,/預約項目：身體60/);
 assert.doesNotMatch(special,/預約人：|電話：|0900000000|未取得預約人資料/);
 const ordinary=ctx.BookingCopyText.formatClipboard(data);
 assert.match(ordinary,/預約人：王先生/);
 assert.match(ordinary,/電話：0900000000/);
 assert.doesNotMatch(ordinary,/預約來源：櫃檯人員/);
 const frontend=read('booking-copy-format.js');
 assert.match(frontend,/omitContact:card\.dataset\.bookingFrontdeskReplacement === 'true'/);
});


test('AC-FR-DURATION-001..004: paired on-site registration uses direct duration without service catalog',()=>{
 const ui=read('frontdesk/app.js');
 const api=read('supabase/functions/_shared/frontdesk-handler.mjs');
 const sql=read('supabase/migrations/20261121221000_frontdesk_direct_duration.sql');
 assert.match(ui,/totalDurationMinutes:Number\(duration.value\)/);
 assert.doesNotMatch(ui,/request\('frontdesk.phone.catalog'\)/);
 assert.match(api,/Number.isInteger\(body.totalDurationMinutes\)/);
 assert.match(api,/body.items!==undefined/);
 assert.match(sql,/frontdesk_create_duration_booking/);
 assert.match(sql,/booking_slot_fits/);
 assert.match(sql,/booking_slot_start_at/);
 assert.match(sql,/pg_advisory_xact_lock/);
 assert.match(sql,/REQUEST_ID_CONFLICT/);
 assert.match(sql,/BOOKING_SLOT_TAKEN/);
 assert.match(sql,/booking_participant_items/);
 assert.match(sql,/BOOKING_PHONE_CREATED/);
 assert.match(sql,/FRONTDESK_DURATION_ROUTER_CONTRACT_CHANGED/);
 const guard=read('supabase/migrations/20261121221500_frontdesk_direct_duration_bundle_guard.sql');
 assert.match(guard,/FRONTDESK_DIRECT_DURATION_VERIFIED/);
 assert.match(guard,/v_store_count = 1 and v_visible_count = 0/);
 assert.match(guard,/frontdesk_paired_phone_source/);
 assert.match(guard,/counts_toward_membership=false/);
 assert.match(guard,/booking_participant_items/);
 assert.match(guard,/FRONTDESK_BUNDLE_CONTRACT_CHANGED/);
 const provisioning=read('supabase/migrations/20261121222000_frontdesk_direct_duration_provisioning_template.sql');
 assert.match(provisioning,/platform_private.business_templates/);
 assert.match(provisioning,/business_sql/);
 assert.match(provisioning,/FRONTDESK_BUNDLE_TEMPLATE_UNSCOPED/);
 assert.match(provisioning,/booking_audit_events/);
 assert.match(provisioning,/frontdesk_paired_phone_source/);
 assert.match(provisioning,/FRONTDESK_BUNDLE_TEMPLATE_CONTRACT_CHANGED/);
});
