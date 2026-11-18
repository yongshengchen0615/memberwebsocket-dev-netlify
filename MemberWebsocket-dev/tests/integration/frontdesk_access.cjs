const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const fixture=require('./business-platform-fixture.cjs');
const owner='U'+'2'.repeat(32),staff='U'+'4'.repeat(32),other='U'+'5'.repeat(32),channel='2010999999';
const migration=()=>fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261118122150_frontdesk_booking_access.sql'),'utf8');
test('frontdesk: tenant-scoped applications, modes, revocation, outbox, transitions, idempotency and RLS',async()=>{
 const h=await fixture();try{
  const t=await h.approve(owner,'desk-shop');
  await h.db.exec(fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261026050904_line_webhook.sql'),'utf8'));
  await h.db.exec(migration());
  const call=async(name,args)=>(await h.db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
  const now=()=>new Date().toISOString();
  const admin=(action,body={})=>call('platform_frontdesk_admin',[owner,t.id,now(),action,{requestId:crypto.randomUUID(),payloadHash:'a'.repeat(64),...body}]);
  const req=(action,body={},actor=staff,tid=t.id,aud=channel)=>call('platform_frontdesk_request',[tid,actor,aud,now(),action,action==='apply'?{verifiedMessagingChannelId:'2010888888',verifiedConfigRevision:2,...body}:body]);
  const config={loginChannelId:channel,liffId:channel+'-desk',messagingChannelId:'2010888888',oaId:'@desk',enabled:true,expectedVersion:1,envelope:{version:1,iv:'a'.repeat(16),data:'b'.repeat(48)}};
  await admin('settings.save',config);
  assert.equal((await call('platform_frontdesk_context',['desk-shop'])).frontdesk.loginChannelId,channel);
  await assert.rejects(req('apply',{},staff,t.id,'2010000000'),/FRONTDESK_AUTH_INVALID/);
  await req('apply',{displayName:'櫃檯 A',oaVerified:true});await req('apply',{displayName:'重複',oaVerified:true});
  let people=(await admin('get')).staff;assert.equal(people.length,1);assert.equal(people[0].status,'pending');
  await assert.rejects(req('bookings'),/FRONTDESK_REVIEW_REQUIRED/);
  await admin('staff.save',{staffId:people[0].id,expectedVersion:people[0].version,status:'approved',permissionMode:'notify_only'});
  assert.equal((await req('bootstrap')).staff.permissionMode,'notify_only');
  await assert.rejects(req('bookings'),/FRONTDESK_REVIEW_REQUIRED/);
  people=(await admin('get')).staff;await admin('staff.save',{staffId:people[0].id,expectedVersion:people[0].version,status:'approved',permissionMode:'review'});
  const s=t.runtime_schema,q=async(sql,args=[])=>(await h.db.query(sql.replaceAll('S.',s+'.'),args)).rows;
  await q("update S.booking_settings set require_primary_technician=false,work_start_time='08:00',work_end_time='22:00'");
  const m=(await q("insert into S.members(line_user_id,member_code,invite_code,status,membership_status,is_test_account)values($1,'FD-M','ABCD123456','active','active',true)returning id",['U'+'3'.repeat(32)]))[0].id;
  await q('update S.members set is_test_account=false where id=$1',[m]);
  await q("insert into S.booking_service_types(name)values('FD')");
  const svc=(await q("insert into S.booking_services(title,duration_minutes,price_amount,service_type,created_by)values('FD service',30,100,'FD',$1)returning id",[owner]))[0].id;
  const make=async()=>(await q('select (S.create_group_booking_request_v2($1,$2,current_date+3,\'10:00\',$3,\'\')).id id',['FD-'+crypto.randomUUID(),m,[{technicianId:null,items:[{serviceId:svc,quantity:1}]}]]))[0].id;
  const b=await make(),rows=await q('select * from S.notice_outbox where booking_id=$1',[b]);
  assert.equal(rows.filter(x=>x.channel==='frontdesk').length,1);assert.equal(rows.find(x=>x.channel==='frontdesk').message_text,rows.find(x=>x.channel==='admin').message_text);
  await h.db.exec('begin');await q("update S.bookings set member_note='會員變更測試' where id=$1",[b]);
  await q("insert into S.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)values($1,'member','BOOKING_UPDATED','booking',$2,'success','{}')",['U'+'3'.repeat(32),b]);await h.db.exec('commit');
  const modified=await q("select * from S.notice_outbox where booking_id=$1 and coalesce_key is not null",[b]);assert.equal(modified.filter(x=>x.channel==='frontdesk').length,1);assert.equal(modified.find(x=>x.channel==='frontdesk').message_text,modified.find(x=>x.channel==='admin').message_text);
  const bookings=await req('bookings');assert.equal(bookings.bookings.length,1);assert.equal(bookings.bookings[0].id,b);
  const body={bookingId:b,expectedUpdatedAt:bookings.bookings[0].updatedAt,status:'confirmed',requestId:crypto.randomUUID()};
  const applied=await req('booking.update',body);assert.equal(applied.booking.status,'confirmed');assert.equal((await req('booking.update',body)).alreadyApplied,true);
  await assert.rejects(req('booking.update',{...body,status:'rejected'}),/FRONTDESK_REQUEST_CONFLICT/);
  await assert.rejects(req('booking.update',{...body,requestId:crypto.randomUUID(),expectedUpdatedAt:applied.booking.updatedAt,status:'rejected'}),/BOOKING_CONFLICT/);
  assert.equal((await q('select confirmed_by from S.bookings where id=$1',[b]))[0].confirmed_by,staff);
  const cancellation=await make();await q('update S.bookings set cancellation_requested_at=now(),cancellation_requested_by=$2,cancellation_source_status=status where id=$1',[cancellation,'U'+'3'.repeat(32)]);
  const cancellationBefore=(await q('select * from S.bookings where id=$1',[cancellation]))[0];
  const notices=await q("select * from S.notice_outbox where booking_id=$1 and event_key like '%:cancellation_requested:%'",[cancellation]);assert.equal(notices.filter(x=>x.channel==='frontdesk').length,1);assert.equal(notices.find(x=>x.channel==='frontdesk').message_text,notices.find(x=>x.channel==='admin').message_text);
  await assert.rejects(req('booking.update',{bookingId:cancellation,status:'rejected',expectedUpdatedAt:cancellationBefore.updated_at,requestId:crypto.randomUUID()}),/BOOKING_CANCELLATION_PENDING/);assert.deepEqual((await q('select * from S.bookings where id=$1',[cancellation]))[0],cancellationBefore);
  assert.equal((await q("select count(*)::int n from S.notice_outbox where booking_id=$1 and channel='member'",[b]))[0].n,1);
  await q("insert into S.admins(line_user_id,display_name,role,status) values($1,'second admin','admin','active')",[other]);
  const multiple=await make();assert.equal((await q("select count(*)::int n from S.notice_outbox where booking_id=$1 and channel='frontdesk'",[multiple]))[0].n,1);
  await q("update S.admins set status='pending'");
  const noAdmin=await make(),solo=await q('select * from S.notice_outbox where booking_id=$1',[noAdmin]);assert.equal(solo.length,1);assert.equal(solo[0].channel,'frontdesk');
  const before=(await q('select updated_at from S.bookings where id=$1',[noAdmin]))[0].updated_at;
  const rejected=await req('booking.update',{bookingId:noAdmin,status:'rejected',expectedUpdatedAt:before,requestId:crypto.randomUUID()});assert.equal(rejected.booking.status,'rejected');
  const foreign=await h.approve(other,'foreign-desk');await assert.rejects(req('bookings',{},staff,foreign.id),/FRONTDESK_/);
  await assert.rejects(call('platform_frontdesk_admin',[other,t.id,now(),'get',{}]),/PLATFORM_/);
  people=(await admin('get')).staff;await admin('staff.save',{staffId:people[0].id,expectedVersion:people[0].version,status:'approved',permissionMode:'notify_only'});
  await assert.rejects(req('booking.update',{...body,requestId:crypto.randomUUID()}),/FRONTDESK_REVIEW_REQUIRED/);
  const queued=(await q("select id from S.notice_outbox where channel='frontdesk' and status in ('pending','sending')")).map(x=>x.id);assert.ok(queued.length>0);
  people=(await admin('get')).staff;await admin('staff.save',{staffId:people[0].id,expectedVersion:people[0].version,status:'suspended',permissionMode:'notify_only'});
  assert.equal((await call('platform_frontdesk_delivery',[t.id,staff])).allowed,false);
  people=(await admin('get')).staff;await admin('staff.save',{staffId:people[0].id,expectedVersion:people[0].version,status:'approved',permissionMode:'notify_only'});
  assert.equal((await call('platform_frontdesk_delivery',[t.id,staff])).allowed,true);
  for(const id of queued)assert.equal((await q('select status from S.notice_outbox where id=$1',[id]))[0].status,'skipped','revocation is terminal even if reapproved before claim');
  const newBooking=await make();assert.equal((await q("select count(*)::int n from S.notice_outbox where booking_id=$1 and channel='frontdesk' and status='pending'",[newBooking]))[0].n,1);
  const beforeTenant=(await h.db.query('select * from platform_private.tenants where id=$1',[t.id])).rows[0];
  for(const [change,restore] of [
   ["update platform_private.tenants set features=jsonb_set(features,'{booking}','false') where id=$1","update platform_private.tenants set features=jsonb_set(features,'{booking}','true') where id=$1"],
   ["update platform_private.tenants set status='suspended' where id=$1","update platform_private.tenants set status='active' where id=$1"],
   ["update platform_private.tenants set expires_at=now()-interval '1 day' where id=$1",null],
  ]){await h.db.query(change,[t.id]);await assert.rejects(req('bootstrap'),/FRONTDESK_UNAVAILABLE/);assert.equal((await call('platform_frontdesk_delivery',[t.id,staff])).allowed,false);if(restore)await h.db.query(restore,[t.id]);else await h.db.query('update platform_private.tenants set expires_at=$2 where id=$1',[t.id,beforeTenant.expires_at]);}
  for(const role of ['anon','authenticated']){await h.db.exec('set role '+role);await assert.rejects(call('platform_frontdesk_request',[t.id,staff,channel,now(),'bootstrap',{}]),/permission denied/);await h.db.exec('reset role');}
  assert.equal(JSON.stringify(await admin('get')).includes('envelope'),false);
 }finally{await h.db.close();}
});
