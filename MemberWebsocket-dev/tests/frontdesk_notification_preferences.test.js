const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const migration=read('supabase/migrations/20261126210000_frontdesk_notification_preferences.sql');

test('AC-FD-NOTIFY-001: approved staff retain notifications by default; no self-service without delegation',()=>{
 assert.match(migration,/allow_notification_toggle boolean not null default false/);
 assert.match(migration,/receive_notifications boolean not null default true/);
 assert.match(migration,/s\.allow_notification_toggle/);
 assert.match(migration,/s\.receive_notifications/);
});

test('AC-FD-NOTIFY-002: merchant delegates an independent permission, never changes booking review rights',async()=>{
 const {frontdeskAdmin}=await import('../supabase/functions/_shared/frontdesk-admin.mjs');
 const calls=[],tenant={id:'10000000-0000-4000-8000-000000000001',features:{booking:true,frontdesk:true}};
 const base={db:{rpc:async(name,args)=>{calls.push({name,args});return{data:{staff:[]},error:null};}},actor:'U'+'2'.repeat(32),issuedAt:new Date().toISOString(),tenant};
 const body={action:'platform.frontdesk.staff.save',staffId:crypto.randomUUID(),status:'approved',permissionMode:'notify_only',allowNotificationToggle:true,expectedVersion:1,requestId:crypto.randomUUID()};
 await frontdeskAdmin({...base,body});
 assert.equal(calls.at(-1).args.p_body.allowNotificationToggle,true);
 assert.equal(calls.at(-1).args.p_body.permissionMode,'notify_only');
 await assert.rejects(frontdeskAdmin({...base,body:{...body,allowNotificationToggle:'false'}}),/通知設定權限/);
});

test('AC-FD-NOTIFY-003: staff mutation requires valid boolean and verified LINE identity',async()=>{
 const {createFrontdeskHandler}=await import('../supabase/functions/_shared/frontdesk-handler.mjs');
 const actor='U'+'4'.repeat(32),calls=[];
 const context={id:'10000000-0000-4000-8000-000000000001',slug:'shop-a',frontdesk:{enabled:true,loginChannelId:'2010999999'}};
 const db={rpc:async(name,args)=>{calls.push({name,args});return{data:name==='consume_api_rate_limit'?true:name==='platform_frontdesk_context'?context:{staff:{receiveNotifications:args.p_enabled}},error:null};}};
 const handler=createFrontdeskHandler({db,allowedOrigins:new Set(['https://allowed.test']),verifyIdentity:async token=>{
  if(token!=='valid')throw {status:401,code:'AUTH_INVALID',message:'invalid'};
  return {lineUserId:actor,issuedAtMs:Date.now()};
 }});
 const send=async (body,idToken='valid')=>{const r=await handler(new Request('https://api.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({action:'frontdesk.notifications.set',business:'shop-a',idToken,...body})}));return{status:r.status,data:await r.json()};};
 assert.equal((await send({enabled:'false'})).status,400);
 assert.equal(calls.length,0,'bad payload never reaches database');
 assert.equal((await send({enabled:false},'forged')).status,401);
 assert.equal((await send({enabled:false,actor:'U'+'9'.repeat(32)})).status,200);
 let last=calls.at(-1);
 assert.equal(last.name,'platform_frontdesk_notification_preference');
 assert.equal(last.args.p_actor,actor,'never accept a supplied actor');
 assert.equal(last.args.p_enabled,false);
 assert.equal((await send({enabled:true})).status,200);
 assert.equal(calls.at(-1).args.p_enabled,true);
});

test('AC-FD-NOTIFY-004: SQL authorizes staff identity and delivery; pause drains waiting jobs, not bookings',()=>{
 assert.match(migration,/or not s\.allow_notification_toggle/);
 assert.match(migration,/p_issued_at<=coalesce\(s\.access_revoked_before/);
 assert.match(migration,/where tenant_id=t\.id and login_channel_id=p_channel_id and line_user_id=p_actor/);
 assert.match(migration,/status=''skipped'',last_error=''FRONTDESK_NOTIFICATIONS_PAUSED''/);
 assert.match(migration,/s\.receive_notifications and t\.module_line/);
 assert.doesNotMatch(migration,/delete from %I\.bookings/i);
 assert.match(migration,/revoke all on function public\.platform_frontdesk_notification_preference/);
 assert.match(migration,/grant execute on function public\.platform_frontdesk_notification_preference[\s\S]*?to service_role/);
});

test('AC-FD-NOTIFY-005: merchant and staff surfaces expose scoped controls',()=>{
 const admin=read('admin/frontdesk-settings.js');
 const staff=read('frontdesk/app.js');
 assert.match(admin,/允許此人員自行開關 LINE 預約通知/);
 assert.match(admin,/allowNotificationToggle:allowToggle\.checked/);
 assert.match(staff,/if\(person\.allowNotificationToggle===true\)/);
 assert.match(staff,/frontdesk\.notifications\.set/);
 assert.match(staff,/接收 LINE 預約通知/);
 assert.match(staff,/不影響櫃檯預約操作/);
});

test('AC-FD-BATCH-API: one bounded, ordered and idempotent merchant batch payload',async()=>{
 const {frontdeskAdmin}=await import('../supabase/functions/_shared/frontdesk-admin.mjs');
 const calls=[],tenant={id:'10000000-0000-4000-8000-000000000001',features:{booking:true,frontdesk:true}};
 const base={db:{rpc:async(name,args)=>{calls.push({name,args});return{data:{staff:[]},error:null};}},actor:'U'+'2'.repeat(32),issuedAt:new Date().toISOString(),tenant};
 const a='10000000-0000-4000-8000-000000000002',b='10000000-0000-4000-8000-000000000003';
 const batch={action:'platform.frontdesk.staff.batch',requestId:crypto.randomUUID(),expectedVersion:4,updates:[
  {staffId:b,expectedVersion:2,status:'approved',permissionMode:'review',allowNotificationToggle:false},
  {staffId:a,expectedVersion:1,status:'rejected',permissionMode:'notify_only',allowNotificationToggle:true}
 ]};
 await frontdeskAdmin({...base,body:batch});
 assert.equal(calls.length,1);
 assert.equal(calls[0].name,'platform_frontdesk_admin');
 assert.equal(calls[0].args.p_action,'staff.batch');
 assert.deepEqual(calls[0].args.p_body.updates.map(x=>x.staffId),[a,b],'same stable lock order');
 assert.match(calls[0].args.p_body.payloadHash,/^[a-f0-9]{64}$/);
 const bad=[
  {...batch,updates:[batch.updates[0],batch.updates[0]]},
  {...batch,updates:[]},
  {...batch,updates:Array.from({length:101},()=>batch.updates[0])},
  {...batch,updates:[{...batch.updates[0],allowNotificationToggle:'false'}]},
  {...batch,updates:[{...batch.updates[0],status:'pending'}]},
  {...batch,updates:[{...batch.updates[0],expectedVersion:-1}]},
  {...batch,updates:[{...batch.updates[0],staffId:'another-tenant'}]}
 ];
 for(const body of bad)await assert.rejects(frontdeskAdmin({...base,body}),error=>error?.status===400);
 assert.equal(calls.length,1,'invalid batches never reach the database');
});

test('AC-FD-BATCH-SQL: tenant authorization, atomic staff updates, version fencing and revocation',()=>{
 const sql=read('supabase/migrations/20261126224000_frontdesk_staff_batch_permissions.sql');
 assert.match(sql,/platform_frontdesk_admin\(text,uuid,timestamptz,text,jsonb\)/);
 assert.match(sql,/p_action='staff\.batch'/);
 assert.match(sql,/jsonb_array_length\(p_body->'updates'\) not between 1 and 100/);
 assert.match(sql,/order by value->>'staffId'/);
 assert.match(sql,/tenant_id=t\.id for update/);
 assert.match(sql,/s\.version is distinct from/);
 assert.match(sql,/FRONTDESK_OA_REQUIRED/);
 assert.match(sql,/FRONTDESK_ACCESS_REVOKED/);
 assert.match(sql,/when p_action=''staff\.batch'' then jsonb_build_object/);
 const admin=read('admin/frontdesk-settings.js');
 assert.match(admin,/frontdesk-tab-staff/);
 assert.match(admin,/platform\.frontdesk\.staff\.batch/);
 assert.match(admin,/請選擇審核結果/);
 assert.doesNotMatch(admin,/void save\('platform\.frontdesk\.staff\.save'/);
 const handler=read('supabase/functions/_shared/platform-handler.mjs');
 assert.match(handler,/platform\.frontdesk\.staff\.batch/);
});

test('AC-FD-NOTIFY-UI-001: merchant sees explicit LINE delivery eligibility and personal preference, without a new write API',()=>{
 const admin=read('admin/frontdesk-settings.js');
 const css=read('admin/frontdesk-settings/frontdesk-settings-page.css');
 const html=read('admin/frontdesk-settings/index.html');
 assert.match(admin,/receiveNotifications === false/);
 assert.match(admin,/person\.status !== 'approved' \|\| cfg\.enabled === false/);
 for(const label of ['LINE 通知：已開啟','LINE 通知：已暫停','LINE 通知：無法接收'])
  assert.ok(admin.includes(label));
 assert.match(admin,/frontdesk-notification-badge/);
 assert.match(admin,/通知狀態依伺服器資料顯示/);
 assert.match(admin,/只授權本人控制通知，不會直接開啟通知/);
 assert.match(css,/\.frontdesk-notification-badge\[data-state="paused"\]/);
 assert.match(css,/\.frontdesk-staff-metrics/);
 assert.match(html,/notification-ui-20261127-1/);
});

test('AC-FD-NOTIFY-UI-002: staff search and notice filters are read-only; pending batch saves stay intact',()=>{
 const admin=read('admin/frontdesk-settings.js');
 assert.match(admin,/function applyStaffFilter\(\)/);
 assert.match(admin,/searchInput\.addEventListener\('input', applyStaffFilter\)/);
 assert.match(admin,/filterSelect\.addEventListener\('change', applyStaffFilter\)/);
 assert.match(admin,/row\.hidden = !\(matchesName && matchesState\)/);
 assert.match(admin,/staffRows\.push\(\{person,row,state,mode,allowToggle\}\)/);
 assert.match(admin,/saveAll\.dataset\.hasChanges = String\(count > 0\)/);
 assert.match(admin,/control\.dataset\.hasChanges !== 'true'/);
 assert.match(admin,/platform\.frontdesk\.staff\.batch/);
 assert.doesNotMatch(admin,/platform\.frontdesk\.staff\.toggle/);
});
