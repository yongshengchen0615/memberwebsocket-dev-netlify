const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const database=require('./database.cjs'),fixture=require('../business-platform-fixture.cjs');
const owner='U'+'2'.repeat(32),staff='U'+'4'.repeat(32),channel='2010999999';
test('PostgreSQL frontdesk: two physical writers, revoke ordering, idempotency, rollback and backup restore',async()=>{
 const h=await fixture(await database());try{
  const t=await h.approve(owner,'desk-pg'),s=t.runtime_schema;
  // The reusable merchant fixture predates the independent frontdesk grant.
  // Upgrade the real grant validation first, then enable it ONLY for this
  // isolated synthetic tenant. Subsequent RPC permission checks remain active.
  for(const name of ['20261026050904_line_webhook.sql','20261118122150_frontdesk_booking_access.sql','20261118190000_frontdesk_safeupdate_projection.sql','20261119150000_frontdesk_independent_feature_grant.sql','20261120223000_booking_rejection_reason_notices.sql','20261121224500_frontdesk_conflict_history_policy.sql','20261122133000_frontdesk_history_booking_scope.sql'])await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations',name),'utf8'));
  await h.db.query("update platform_private.tenants set features=features||jsonb_build_object('frontdesk',true) where id=$1",[t.id]);
  const query='select public.platform_frontdesk_request($1,$2,$3,$4,$5,$6) result',adminQuery='select public.platform_frontdesk_admin($1,$2,$3,$4,$5) result',issued=new Date(Date.now()+1000).toISOString();
  const actorArgs=(action,body)=>[t.id,staff,channel,issued,action,body],adminArgs=(action,body)=>[owner,t.id,issued,action,{requestId:crypto.randomUUID(),payloadHash:'a'.repeat(64),...body}];
  const first=await h.db.connect(),second=await h.db.connect();await first.query('set role service_role');await second.query('set role service_role');
  const pid=(await second.query('select pg_backend_pid() pid')).rows[0].pid;
  const blocked=async()=>{for(let i=0;i<100;i++){if((await h.db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return;}throw Error('EXPECTED_PHYSICAL_LOCK_WAIT');};
  await first.query(adminQuery,adminArgs('settings.save',{loginChannelId:channel,liffId:channel+'-desk',messagingChannelId:'2010888888',oaId:'@desk',enabled:true,expectedVersion:1,envelope:{version:1,iv:'a'.repeat(16),data:'b'.repeat(48)}}));
  const person=(await first.query(query,actorArgs('apply',{displayName:'Synthetic desk',oaVerified:true,verifiedMessagingChannelId:'2010888888',verifiedConfigRevision:2}))).rows[0].result.staff;
  await first.query(adminQuery,adminArgs('staff.save',{staffId:person.id,expectedVersion:1,status:'approved',permissionMode:'review'}));
  await h.db.exec(`update ${s}.booking_settings set require_primary_technician=false,work_start_time='08:00',work_end_time='22:00';insert into ${s}.booking_service_types(name)values('FD');`);
  const member=(await h.db.query(`insert into ${s}.members(line_user_id,member_code,invite_code,status,membership_status,is_test_account)values($1,'FD-PG','ABCD123456','active','active',true)returning id`,['U'+'3'.repeat(32)])).rows[0].id;
  await h.db.query(`update ${s}.members set is_test_account=false where id=$1`,[member]);
  const service=(await h.db.query(`insert into ${s}.booking_services(title,duration_minutes,price_amount,service_type,created_by)values('FD',30,100,'FD',$1)returning id`,[owner])).rows[0].id;
  const make=async()=>{const id=(await h.db.query(`select (${s}.create_group_booking_request_v2($1,$2,current_date+3,'10:00',$3,'')).id id`,['FD-'+crypto.randomUUID(),member,[{technicianId:null,items:[{serviceId:service,quantity:1}]}]])).rows[0].id;return(await h.db.query(`select * from ${s}.bookings where id=$1`,[id])).rows[0];};
  const b=await make(),body={bookingId:b.id,expectedUpdatedAt:b.updated_at,status:'confirmed',requestId:crypto.randomUUID()};
  await first.query('begin');await first.query(query,actorArgs('booking.update',body));
  const competing=second.query(query,actorArgs('booking.update',{...body,status:'rejected',rejectionReason:'technician_leave',requestId:crypto.randomUUID()}));competing.catch(()=>{});await blocked();await first.query('commit');await assert.rejects(competing,/BOOKING_CONFLICT/);
  assert.equal((await h.db.query(`select status from ${s}.bookings where id=$1`,[b.id])).rows[0].status,'confirmed');
  assert.equal((await h.db.query(`select count(*)::int n from ${s}.booking_audit_events where target_id=$1 and actor_role='frontdesk'`,[b.id])).rows[0].n,1);
  const replay=(await second.query(query,actorArgs('booking.update',body))).rows[0].result;assert.equal(replay.alreadyApplied,true);
  const next=await make(),nextBody={bookingId:next.id,expectedUpdatedAt:next.updated_at,status:'rejected',rejectionReason:'technician_leave',requestId:crypto.randomUUID()};
  // Synthetic audit rows exercise history filtering before the 30-entry limit.
  // No production booking or member data is touched.
  const audit=`insert into ${s}.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
   select $1,'frontdesk','BOOKING_REJECTED','booking',$2,'success',jsonb_build_object('rejectionReason','unrecorded_phone_booking') from generate_series(1,$3::int)`;
  await first.query(audit,[staff,b.id,1]);
  await first.query(audit,[staff,next.id,31]);
  const scoped=(await first.query(query,actorArgs('history',{bookingId:b.id}))).rows[0].result;
  assert.equal(scoped.items.length,1,'single-order lookup must find a record beyond the most recent 30');
  assert.equal(scoped.items[0].booking.id,b.id);
  const broad=(await first.query(query,actorArgs('history',{}))).rows[0].result;
  assert.equal(broad.items.length,30,'ordinary frontdesk history retains the latest 30 records');
  assert.ok(broad.items.every(item=>item.booking.id===next.id));
  await assert.rejects(first.query(query,[t.id,'U'+'5'.repeat(32),channel,issued,'history',{bookingId:b.id}]),/FRONTDESK_REVIEW_REQUIRED/);
  assert.equal((await h.db.query(`select status from ${s}.bookings where id=$1`,[b.id])).rows[0].status,'confirmed','history requests are read only');
  await first.query('begin');await first.query(query,actorArgs('booking.update',nextBody));await first.query('rollback');assert.equal((await h.db.query(`select status from ${s}.bookings where id=$1`,[next.id])).rows[0].status,'pending');
  await first.query('begin');await first.query(adminQuery,adminArgs('staff.save',{staffId:person.id,expectedVersion:2,status:'suspended',permissionMode:'review'}));
  const revoked=second.query(query,actorArgs('booking.update',nextBody));revoked.catch(()=>{});await blocked();await first.query('commit');await assert.rejects(revoked,/FRONTDESK_REVIEW_REQUIRED/);
  assert.equal((await h.db.query(`select status from ${s}.bookings where id=$1`,[next.id])).rows[0].status,'pending');
  const restored=await h.db.backupRestore();assert.equal((await restored.client.query('select status from platform_private.frontdesk_staff where id=$1',[person.id])).rows[0].status,'suspended');assert.equal((await restored.client.query(`select status from ${s}.bookings where id=$1`,[b.id])).rows[0].status,'confirmed');assert.match(restored.checksum,/^[a-f0-9]{64}$/);
 }finally{await h.db.close();}
});
