const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),fixture=require('./business-platform-fixture.cjs'),{key}=require('./platform-fixture.cjs');
test('frontdesk API + real SQL: owner-scoped configuration, encrypted bot, verified applicant, per-person authorization and disable',async()=>{
 const h=await fixture();try{
  const owner='U'+'2'.repeat(32),staff='U'+'4'.repeat(32),t=await h.approve(owner,'desk-api');
  for(const name of ['20261026050904_line_webhook.sql','20261118122150_frontdesk_booking_access.sql','20261118190000_frontdesk_safeupdate_projection.sql','20261119150000_frontdesk_independent_feature_grant.sql','20261119230000_frontdesk_staff_delete.sql','20261126210000_frontdesk_notification_preferences.sql'])await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations',name),'utf8'));
  // The testing Supabase database already received this additive migration via
  // management API; the release ledger may replay it. Re-application must be safe.
  await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations/20261126210000_frontdesk_notification_preferences.sql'),'utf8'));
  await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations/20261126224000_frontdesk_staff_batch_permissions.sql'),'utf8'));
  await h.db.query("update platform_private.tenants set features=features||'{\"frontdesk\":true}'::jsonb where id=$1",[t.id]);
  const {createPlatformHandler}=await import('../../supabase/functions/_shared/platform-handler.mjs'),{createFrontdeskHandler}=await import('../../supabase/functions/_shared/frontdesk-handler.mjs');
  const provider=[];let reachable=true;
  const fetchImpl=async(url,options)=>{provider.push({url,options});return new Response(JSON.stringify(url.endsWith('/verify')?{client_id:'2010888888',expires_in:3600}:url.endsWith('/bot/info')?{basicId:'@desk',userId:'U'+'a'.repeat(32)}:{userId:reachable?staff:'U'+'f'.repeat(32)}));};
  const allowedOrigins=new Set(['https://allowed.test']),db={rpc:h.rpc};
  const admin=createPlatformHandler({db,allowedOrigins,encryptionKey:()=>key,fetchImpl,verifyApplicantIdentity:async()=>({lineUserId:owner,issuedAtMs:Date.now()}),verifyIdentity:()=>assert.fail('must use merchant audience')});
  const desk=createFrontdeskHandler({db,allowedOrigins,encryptionKey:()=>key,fetchImpl,verifyIdentity:async(token,channel)=>{assert.equal(channel,'2010999999');assert.equal(token,'staff-token');return {lineUserId:staff,displayName:'櫃檯 A',issuedAtMs:Date.now()};}});
  const call=async(handler,body)=>{const r=await handler(new Request('https://api.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({idToken:handler===admin?'owner-token':'staff-token',business:t.slug,...body})}));return {status:r.status,body:await r.json()};};
  const settings={loginChannelId:'2010999999',liffId:'2010999999-desk',messagingChannelId:'2010888888',enabled:true},token='synthetic-frontdesk-channel-token-123456';
  const first={action:'platform.frontdesk.settings.save',requestId:crypto.randomUUID(),expectedVersion:1,settings,channelAccessToken:token};
  let result=await call(admin,first);assert.equal(result.status,200,JSON.stringify(result));const n=provider.length;assert.equal((await call(admin,first)).status,200);assert.equal(provider.length,n,'committed replay never recontacts LINE');
  assert.equal(JSON.stringify(result).includes(token),false);assert.equal(JSON.stringify(result).includes('envelope'),false);
  reachable=false;assert.equal((await call(desk,{action:'frontdesk.apply',actor:owner})).status,409);assert.equal((await h.db.query('select count(*)::int n from platform_private.frontdesk_staff')).rows[0].n,0);
  reachable=true;result=await call(desk,{action:'frontdesk.apply',actor:owner,permissionMode:'review',status:'approved'});assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.data.staff.status,'pending');
  const person=result.body.data.staff;
  assert.equal(result.body.data.lineApplicationMessage,undefined,'the backend must not impersonate the applicant with OA Push');
  assert.equal(provider.filter(call=>call.url==='https://api.line.me/v2/bot/message/push').length,0,
   'staff applications never use OA-to-user Push; user chat messaging belongs to the LIFF client');

  result=await call(admin,{action:'platform.frontdesk.staff.save',staffId:person.id,expectedVersion:person.version,status:'approved',permissionMode:'notify_only',requestId:crypto.randomUUID()});assert.equal(result.status,200,JSON.stringify(result));
  assert.equal((await call(desk,{action:'frontdesk.bookings'})).status,403);
  // AC-FD-NOTIFY-001..006: real SQL authorization, per-person switch and delivery.
  assert.equal((await call(desk,{action:'frontdesk.notifications.set',enabled:false})).status,403,
   'approved staff cannot change notifications without merchant delegation');
  const delegated=await call(admin,{action:'platform.frontdesk.staff.save',staffId:person.id,expectedVersion:2,status:'approved',permissionMode:'notify_only',allowNotificationToggle:true,requestId:crypto.randomUUID()});
  assert.equal(delegated.status,200,JSON.stringify(delegated));
  const off=await call(desk,{action:'frontdesk.notifications.set',enabled:false});
  assert.equal(off.status,200,JSON.stringify(off));
  assert.equal(off.body.data.staff.receiveNotifications,false);
  assert.equal((await h.db.query('select public.platform_frontdesk_delivery($1,$2) result',[t.id,staff])).rows[0].result.allowed,false);
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.frontdesk_notice_recipients where line_user_id=$1`,[staff])).rows[0].n,0);
  assert.equal((await call(desk,{action:'frontdesk.bookings'})).status,403,'notification switch does not confer review access');
  const on=await call(desk,{action:'frontdesk.notifications.set',enabled:true});
  assert.equal(on.status,200,JSON.stringify(on));
  assert.equal(on.body.data.staff.receiveNotifications,true);
  assert.equal((await h.db.query('select public.platform_frontdesk_delivery($1,$2) result',[t.id,staff])).rows[0].result.allowed,true);
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.frontdesk_notice_recipients where line_user_id=$1`,[staff])).rows[0].n,1);
  // AC-FD-DELETE-001..006: hard delete, no stale privilege, fresh pending approval.
  const deleteBody={action:'platform.frontdesk.staff.delete',staffId:person.id,expectedVersion:on.body.data.staff.version,requestId:crypto.randomUUID()};
  let deleted=await call(admin,deleteBody);
  assert.equal(deleted.status,200,JSON.stringify(deleted));
  assert.equal(deleted.body.data.staff.length,0);
  assert.equal((await h.db.query('select count(*)::int n from platform_private.frontdesk_staff where id=$1',[person.id])).rows[0].n,0);
  assert.equal((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.frontdesk_notice_recipients where line_user_id=$1`,[staff])).rows[0].n,0);
  deleted=await call(admin,deleteBody);
  assert.equal(deleted.status,200,'same idempotency key must replay successful deletion');
  assert.equal((await call(desk,{action:'frontdesk.bootstrap'})).body.data.staff,null);
  assert.equal((await call(desk,{action:'frontdesk.bookings'})).status,403);
  assert.equal((await call(admin,{...deleteBody,requestId:crypto.randomUUID()})).status,404,'different deletion key cannot target absent account');
  const reapplied=await call(desk,{action:'frontdesk.apply'});
  assert.equal(reapplied.status,200,JSON.stringify(reapplied));
  assert.equal(reapplied.body.data.staff.status,'pending');
  assert.notEqual(reapplied.body.data.staff.id,person.id);
  assert.equal(provider.filter(call=>call.url==='https://api.line.me/v2/bot/message/push').length,0,
   'reapplication also must not create an OA-to-user Push');
  assert.equal((await call(desk,{action:'frontdesk.bookings'})).status,403,'reapplication must not restore old privileges');
    const disabled=await call(admin,{action:'platform.frontdesk.settings.save',settings:{...settings,enabled:false},channelAccessToken:'',expectedVersion:2,requestId:crypto.randomUUID()});assert.equal(disabled.status,200,JSON.stringify(disabled));assert.equal(disabled.body.data.frontdesk.oaId,'@desk');
  assert.equal((await call(desk,{action:'frontdesk.bootstrap'})).status,403);
  const secret=(await h.db.query("select envelope from platform_private.module_notification_routes where purpose='frontdesk'")).rows[0].envelope;assert.ok(secret.data);assert.equal(JSON.stringify(secret).includes(token),false);
 }finally{await h.db.close();}
});

test('AC-FD-BATCH-001..006: real SQL batch is atomic on stale staff, idempotent on replay and revokes recipients',async()=>{
 const h=await fixture();try{
  const owner='U'+'2'.repeat(32),t=await h.approve(owner,'desk-batch'),staffA='U'+'4'.repeat(32),staffB='U'+'5'.repeat(32);
  for(const name of ['20261026050904_line_webhook.sql','20261118122150_frontdesk_booking_access.sql','20261118190000_frontdesk_safeupdate_projection.sql','20261119150000_frontdesk_independent_feature_grant.sql','20261119230000_frontdesk_staff_delete.sql','20261126210000_frontdesk_notification_preferences.sql','20261126224000_frontdesk_staff_batch_permissions.sql'])
   await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations',name),'utf8'));
  await h.db.query("update platform_private.tenants set features=features||'{\"frontdesk\":true}'::jsonb where id=$1",[t.id]);
  const {createPlatformHandler}=await import('../../supabase/functions/_shared/platform-handler.mjs');
  const {createFrontdeskHandler}=await import('../../supabase/functions/_shared/frontdesk-handler.mjs');
  let lineStaff=staffA;
  const fetchImpl=async url=>new Response(JSON.stringify(url.endsWith('/verify')?{client_id:'2010888888',expires_in:3600}:url.endsWith('/bot/info')?{basicId:'@desk',userId:owner}:{userId:lineStaff}));
  const db={rpc:h.rpc},allowedOrigins=new Set(['https://allowed.test']);
  const admin=createPlatformHandler({db,allowedOrigins,encryptionKey:()=>key,fetchImpl,verifyApplicantIdentity:async()=>({lineUserId:owner,issuedAtMs:Date.now()})});
  const desk=createFrontdeskHandler({db,allowedOrigins,encryptionKey:()=>key,fetchImpl,verifyIdentity:async()=>({lineUserId:lineStaff,displayName:'合成櫃檯',issuedAtMs:Date.now()})});
  const call=async(handler,body)=>{const r=await handler(new Request('https://api.test',{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify({business:t.slug,idToken:'synthetic-token',...body})}));return{status:r.status,body:await r.json()};};
  const setup=await call(admin,{action:'platform.frontdesk.settings.save',expectedVersion:1,requestId:crypto.randomUUID(),settings:{loginChannelId:'2010999999',liffId:'2010999999-desk',messagingChannelId:'2010888888',enabled:true},channelAccessToken:'synthetic-frontdesk-channel-token-123456'});
  assert.equal(setup.status,200,JSON.stringify(setup));
  const first=(await call(desk,{action:'frontdesk.apply'})).body.data.staff;
  lineStaff=staffB;
  const second=(await call(desk,{action:'frontdesk.apply'})).body.data.staff;
  const rows=[
   {staffId:first.id,expectedVersion:first.version,status:'approved',permissionMode:'review',allowNotificationToggle:true},
   {staffId:second.id,expectedVersion:second.version,status:'approved',permissionMode:'notify_only',allowNotificationToggle:false}
  ];
  const requestBase={action:'platform.frontdesk.staff.batch',expectedVersion:2,requestId:crypto.randomUUID(),updates:rows};
  const stale=await call(admin,{...requestBase,updates:[rows[0],{...rows[1],expectedVersion:999}]});
  assert.equal(stale.status,409,JSON.stringify(stale));
  let dbRows=(await h.db.query('select id,status,version from platform_private.frontdesk_staff where tenant_id=$1 order by id',[t.id])).rows;
  assert.equal(dbRows.every(x=>x.status==='pending'&&Number(x.version)===1),true,'failure of row 2 rolls back row 1');
  const saved=await call(admin,requestBase);assert.equal(saved.status,200,JSON.stringify(saved));
  assert.equal(saved.body.data.staff.every(x=>x.status==='approved'&&x.version===2),true);
  assert.equal(saved.body.data.staff.find(x=>x.id===first.id).permissionMode,'review');
  assert.equal(saved.body.data.staff.find(x=>x.id===first.id).allowNotificationToggle,true);
  assert.deepEqual((await call(admin,requestBase)).body.data,saved.body.data,'same request ID replays the same committed result');
  const rejected=await call(admin,{...requestBase,requestId:crypto.randomUUID()});
  assert.equal(rejected.status,409,'stale versions cannot overwrite approved staff');
  const revoked=await call(admin,{action:'platform.frontdesk.staff.batch',expectedVersion:2,requestId:crypto.randomUUID(),updates:[
   {...rows[0],expectedVersion:2,status:'suspended'},
   {...rows[1],expectedVersion:2,permissionMode:'review'}
  ]});
  assert.equal(revoked.status,200,JSON.stringify(revoked));
  const current=revoked.body.data.staff;
  assert.equal(current.find(x=>x.id===first.id).status,'suspended');
  assert.equal(current.find(x=>x.id===second.id).permissionMode,'review');
  assert.equal((await h.db.query('select count(*)::int n from '+t.runtime_schema+'.frontdesk_notice_recipients where line_user_id=$1',[staffA])).rows[0].n,0);
  assert.equal((await h.db.query('select count(*)::int n from '+t.runtime_schema+'.frontdesk_notice_recipients where line_user_id=$1',[staffB])).rows[0].n,1);
 }finally{await h.db.close();}
});
