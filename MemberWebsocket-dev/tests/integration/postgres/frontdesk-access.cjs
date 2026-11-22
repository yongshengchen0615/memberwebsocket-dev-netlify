const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const database=require('./database.cjs'),fixture=require('../business-platform-fixture.cjs');
const owner='U'+'2'.repeat(32),staff='U'+'4'.repeat(32),channel='2010999999';
test('PostgreSQL frontdesk: two physical writers, revoke ordering, idempotency, rollback and backup restore',async()=>{
 const h=await fixture(await database());try{
  const t=await h.approve(owner,'desk-pg'),s=t.runtime_schema;
  for(const name of ['20261026050904_line_webhook.sql','20261118122150_frontdesk_booking_access.sql','20261118190000_frontdesk_safeupdate_projection.sql'])await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations',name),'utf8'));
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
  const competing=second.query(query,actorArgs('booking.update',{...body,status:'rejected',requestId:crypto.randomUUID()}));competing.catch(()=>{});await blocked();await first.query('commit');await assert.rejects(competing,/BOOKING_CONFLICT/);
  assert.equal((await h.db.query(`select status from ${s}.bookings where id=$1`,[b.id])).rows[0].status,'confirmed');
  assert.equal((await h.db.query(`select count(*)::int n from ${s}.booking_audit_events where target_id=$1 and actor_role='frontdesk'`,[b.id])).rows[0].n,1);
  const replay=(await second.query(query,actorArgs('booking.update',body))).rows[0].result;assert.equal(replay.alreadyApplied,true);
  const next=await make(),nextBody={bookingId:next.id,expectedUpdatedAt:next.updated_at,status:'rejected',requestId:crypto.randomUUID()};
  await first.query('begin');await first.query(query,actorArgs('booking.update',nextBody));await first.query('rollback');assert.equal((await h.db.query(`select status from ${s}.bookings where id=$1`,[next.id])).rows[0].status,'pending');
  await first.query('begin');await first.query(adminQuery,adminArgs('staff.save',{staffId:person.id,expectedVersion:2,status:'suspended',permissionMode:'review'}));
  const revoked=second.query(query,actorArgs('booking.update',nextBody));revoked.catch(()=>{});await blocked();await first.query('commit');await assert.rejects(revoked,/FRONTDESK_REVIEW_REQUIRED/);
  assert.equal((await h.db.query(`select status from ${s}.bookings where id=$1`,[next.id])).rows[0].status,'pending');
  const restored=await h.db.backupRestore();assert.equal((await restored.client.query('select status from platform_private.frontdesk_staff where id=$1',[person.id])).rows[0].status,'suspended');assert.equal((await restored.client.query(`select status from ${s}.bookings where id=$1`,[b.id])).rows[0].status,'confirmed');assert.match(restored.checksum,/^[a-f0-9]{64}$/);
 }finally{await h.db.close();}
});


test('PostgreSQL frontdesk LINE history: scoped booking is found beyond 30 entries, actor-bound and read only',async()=>{
 const h=await fixture(await database());try{
  const t=await h.approve(owner,'desk-history-pg'),s=t.runtime_schema;
  // Provision the independent grant exactly as the forward migrations require.
  // The test-only fixture predates the frontdesk grant; never modify production data.
  for(const name of [
   '20261026050904_line_webhook.sql',
   '20261118122150_frontdesk_booking_access.sql',
   '20261109115000_booking_participant_individual_notes.sql',
   '20261118190000_frontdesk_safeupdate_projection.sql',
   '20261119150000_frontdesk_independent_feature_grant.sql',
   '20261121224500_frontdesk_conflict_history_policy.sql',
   '20261122133000_frontdesk_history_booking_scope.sql',
   '20261122150000_frontdesk_overlap_guard.sql'
  ])await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations',name),'utf8'));
  // This October-based isolated fixture has no install_booking_reminder() used by
  // the full Nov 20 notice migrations. Mirror only their booking column prerequisite
  // to exercise the real SQL router, transaction rollback and cross-actor access.
  // The full release migration path is verified separately by release CI.
  await h.db.exec(`alter table ${s}.bookings add column if not exists rejection_reason text
   check(rejection_reason is null or rejection_reason in ('technician_leave','unrecorded_phone_booking'))`);
  await h.db.query("update platform_private.tenants set features=features||jsonb_build_object('frontdesk',true) where id=$1",[t.id]);
  const conn=await h.db.connect();await conn.query('set role service_role');
  const query='select public.platform_frontdesk_request($1,$2,$3,$4,$5,$6) result';
  const adminQuery='select public.platform_frontdesk_admin($1,$2,$3,$4,$5) result';
  const issued=new Date(Date.now()+1000).toISOString();
  const actorArgs=(action,body,actor=staff)=>[t.id,actor,channel,issued,action,body];
  const adminArgs=(action,body)=>[owner,t.id,issued,action,{requestId:crypto.randomUUID(),payloadHash:'a'.repeat(64),...body}];
  await conn.query(adminQuery,adminArgs('settings.save',{loginChannelId:channel,liffId:channel+'-desk',messagingChannelId:'2010888888',oaId:'@desk',enabled:true,expectedVersion:1,envelope:{version:1,iv:'a'.repeat(16),data:'b'.repeat(48)}}));
  const person=(await conn.query(query,actorArgs('apply',{displayName:'Scoped history staff',oaVerified:true,verifiedMessagingChannelId:'2010888888',verifiedConfigRevision:2}))).rows[0].result.staff;
  await conn.query(adminQuery,adminArgs('staff.save',{staffId:person.id,expectedVersion:1,status:'approved',permissionMode:'review'}));
  await h.db.exec(`update ${s}.booking_settings set require_primary_technician=false,work_start_time='08:00',work_end_time='22:00';insert into ${s}.booking_service_types(name)values('FD');`);
  const member=(await h.db.query(`insert into ${s}.members(line_user_id,member_code,invite_code,status,membership_status,is_test_account)values($1,'FD-H-PG','ABCD123456','active','active',true)returning id`,['U'+'3'.repeat(32)])).rows[0].id;
  await h.db.query(`update ${s}.members set is_test_account=false where id=$1`,[member]);
  const service=(await h.db.query(`insert into ${s}.booking_services(title,duration_minutes,price_amount,service_type,created_by)values('FD',30,100,'FD',$1)returning id`,[owner])).rows[0].id;
  const make=async()=>{const id=(await h.db.query(`select (${s}.create_group_booking_request_v2($1,$2,current_date+3,'10:00',$3,'')).id id`,['FD-'+crypto.randomUUID(),member,[{technicianId:null,items:[{serviceId:service,quantity:1}]}]])).rows[0].id;return id;};
  const target=await make(),other=await make();
  // AC-FD-OVERLAP-004: direct API calls bypass browser controls but must not mutate either booking.
  // Keep PostgreSQL microseconds: node-postgres Date truncates updated_at to ms.
  // The optimistic lock must use the exact stored timestamp, not rounded JS Date.
  const source=(await h.db.query(`select updated_at::text as updated_at from ${s}.bookings where id=$1`,[target])).rows[0];
  for(const [startTime,totalDurationMinutes] of [['10:30',30],['09:20',40]]){
   const phoneRequestId='PHONE-'+crypto.randomUUID();
   await assert.rejects(conn.query(query,actorArgs('booking.reject_phone',{
    bookingId:target,expectedUpdatedAt:source.updated_at,status:'rejected',
    rejectionReason:'unrecorded_phone_booking',requestId:crypto.randomUUID(),
    phoneRequestId,startTime,totalDurationMinutes
   })),/FRONTDESK_NOT_OVERLAPPING/);
   assert.equal((await h.db.query(`select status from ${s}.bookings where id=$1`,[target])).rows[0].status,'pending');
   assert.equal((await h.db.query(`select count(*)::int n from ${s}.bookings where request_id=$1`,[phoneRequestId])).rows[0].n,0);
  }
  // A's audit is older than the 30 most recent audits for another booking.
  // Filtering after LIMIT would incorrectly hide A's history.
  const audit=`insert into ${s}.booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,metadata)
   select $1,'frontdesk','BOOKING_REJECTED','booking',$2,'success',jsonb_build_object('rejectionReason','unrecorded_phone_booking') from generate_series(1,$3::int)`;
  await conn.query(audit,[staff,target,1]);
  await conn.query(audit,[staff,other,31]);
  const scoped=(await conn.query(query,actorArgs('history',{bookingId:target}))).rows[0].result;
  assert.equal(scoped.items.length,1,'single booking history must survive 31 newer unrelated events');
  assert.equal(scoped.items[0].booking.id,target);
  assert.ok(scoped.items.every(x=>x.booking.id!==other),'other bookings never enter a scoped API response');
  const broad=(await conn.query(query,actorArgs('history',{}))).rows[0].result;
  assert.equal(broad.items.length,30,'unscoped frontdesk retains the latest 30 records');
  assert.ok(broad.items.every(x=>x.booking.id===other));
  await assert.rejects(conn.query(query,actorArgs('history',{bookingId:target},'U'+'5'.repeat(32))),/FRONTDESK_REVIEW_REQUIRED/);
  await conn.query(adminQuery,adminArgs('staff.save',{staffId:person.id,expectedVersion:2,status:'suspended',permissionMode:'review'}));
  await assert.rejects(conn.query(query,actorArgs('history',{bookingId:target})),/FRONTDESK_REVIEW_REQUIRED|FRONTDESK_AUTH_INVALID/);
  const count=(await h.db.query(`select count(*)::int n from ${s}.bookings where id=$1 or id=$2`,[target,other])).rows[0].n;
  assert.equal(count,2,'history and revoked access must not delete bookings');
 }finally{await h.db.close();}
});
