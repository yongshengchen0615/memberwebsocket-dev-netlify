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
 assert.equal(calls.filter(c=>c.name==='platform_frontdesk_request').length,0);
 assert.equal((await request({rejectionReason:reasons[0]})).status,200);
 const actual=calls.find(c=>c.name==='platform_frontdesk_request').args.p_body;
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
 assert.match(ui,/電話預約已登記，時間已保留，等待管理員確認/);
 assert.match(ui,/b\.disabled=!slot\.available/);
 assert.match(ui,/frontdeskLockPrevious/);
 assert.match(migration,/admin_create_phone_booking_request/);
 assert.match(migration,/frontdesk_create_phone_booking_request/);
 assert.match(migration,/v_total,''pending''/);
 assert.match(migration,/v_saved\.confirmed_by is distinct from p_actor/);
 assert.match(migration,/p_actor,''frontdesk'',''BOOKING_PHONE_CREATED''/);
 assert.match(migration,/status in \(''pending'',''confirmed''\)/);
 assert.match(migration,/platform_private\.frontdesk_staff/);
 assert.match(migration,/BOOKING_SLOT_TAKEN|PHONE_BOOKING_CONFLICT/);
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
