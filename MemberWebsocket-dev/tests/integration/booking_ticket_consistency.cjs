const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const load=require('./fixtures/load-postgres-snapshot.cjs');
const root=path.resolve(__dirname,'../..');
const migration=fs.readFileSync(path.join(root,'supabase/migrations/20261006023020_booking_ticket_usage_consistency.sql'),'utf8');
test('booking ticket eligibility, service reconciliation and redemption use real PostgreSQL transactions',async t=>{
 const db=await load();
 try{
  await db.exec(migration);
  // Use test-only identities; baseline data is created solely inside this empty database.
  await db.exec('select maintenance.ensure_required_system_baseline();select maintenance.ensure_event_ticket_settings_baseline();');
  const query=async(sql,args=[]) => (await db.query(sql,args)).rows;
  const member=(await query("insert into members(line_user_id,member_code,status,membership_status,is_test_account) values('test:ticket-member','QA-TICKET','active','active',true) returning id"))[0].id;
  const other=(await query("insert into members(line_user_id,member_code,status,membership_status,is_test_account) values('test:ticket-other','QA-OTHER','active','active',true) returning id"))[0].id;
  const tech=(await query('select primary_technician_id id from booking_settings where id=1'))[0].id;
  await query("insert into booking_service_types(name) values('QA')");
  const service=(await query("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by) values('QA service A',30,100,'QA','test:admin') returning id"))[0].id;
  const second=(await query("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by) values('QA service B',30,100,'QA','test:admin') returning id"))[0].id;
  const card=(await query("insert into point_cards(card_id,title,status,created_by,updated_by) values('QA-CARD','QA card','active','test:admin','test:admin') returning id"))[0].id;
  const template=(await query("insert into ticket_templates(ticket_template_id,title,ticket_type,status,created_by,updated_by) values('QA-TEMPLATE','QA coupon','coupon','active','test:admin','test:admin') returning id"))[0].id;
  const reward=(await query("insert into point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id,required_service_ids) values('QA-REWARD',$1,5,$2,$3) returning id",[card,template,[service]]))[0].id;
  await query('insert into point_balances(member_id,point_card_id,stamps) values($1,$2,50)',[member,card]);
  await query("insert into point_tickets(ticket_id,member_id,point_card_id,reward_id,ticket_template_id,threshold_stamps,ticket_type,ticket_title) values('QA-POINT',$1,$2,$3,$4,5,'coupon','QA coupon')",[member,card,reward,template]);
  const event=(await query("insert into event_tickets(event_ticket_id,title,ticket_type,status,created_by,updated_by,required_service_ids) values('QA-EVENT','QA event','coupon','active','test:admin','test:admin',$1) returning id",[[service]]))[0].id;
  await query("insert into event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title) values('QA-CLAIM',$1,$2,'coupon','QA event')",[event,member]);
  const booking=(await query("select (create_booking_bundle_request('BOOK-QA-00000001',$1,'2099-01-01','10:00',$2,'QA')).id id",[member,JSON.stringify([{serviceId:service,quantity:1},{serviceId:"00000000-0000-4000-8000-000000000010",quantity:1}])]))[0].id;
  await query("insert into admins(line_user_id,role,status) values('test:admin','admin','active')");
  const edit=async ids=>query("select admin_update_booking_participant_items_request(id,updated_at,'test:admin',$2) from bookings where id=$1",[booking,JSON.stringify([{position:1,items:ids.map(serviceId=>({serviceId,quantity:1}))}])]);
  const options=async()=>(await query('select member_ticket_booking_options($1) result',[member]))[0].result;
  const redeem=async(kind,refs,req,book=booking,line='test:ticket-member')=>(await query('select redeem_member_tickets_for_booking_request($1,$2,$3,$4,$5,null) result',[line,book,kind,refs,req]))[0].result;
  await t.test('pending, non-owner, malformed and missing bookings cannot redeem',async()=>{
   assert.deepEqual((await options()).points['QA-POINT'],[]);
   for(const [kind,refs]of [['points',['QA-POINT']],['event',['QA-CLAIM']]])await assert.rejects(redeem(kind,refs,'QA-PENDING-1'),/BOOKING_TICKET_CONFIRMATION_REQUIRED/);
   await assert.rejects(redeem('points',['QA-POINT'],'QA-FOREIGN-1',booking,'test:ticket-other'),/BOOKING_NOT_OWNED/);
   await assert.rejects(redeem('points',['QA-POINT'],'QA-MISSING-1','00000000-0000-4000-8000-000000000099'),/BOOKING_NOT_OWNED/);
   await assert.rejects(redeem('points',['QA-POINT','QA-POINT'],'QA-DUPLICATE'),/INVALID_TICKET_BATCH/);
  });
  await query("update bookings set status='confirmed' where id=$1",[booking]);
  await t.test('confirmed eligible booking is explicit; reservation never consumes points',async()=>{
   assert.equal((await options()).points['QA-POINT'][0].bookingId,booking);
   await query('select replace_booking_benefit_selections_request($1,$2,$3)',[booking,member,JSON.stringify([{kind:'points',id:'QA-POINT'},{kind:'event',id:'QA-CLAIM'}])]);
   assert.equal((await query('select stamps from point_balances where member_id=$1 and point_card_id=$2',[member,card]))[0].stamps,50);
   await assert.rejects(redeem('points',['QA-POINT'],'QA-RESERVED-1'),/BOOKING_BENEFIT_RESERVED/);
  });
  await t.test('replacing items cancels only incompatible reservations and preserves tickets and balance',async()=>{
   await query('update event_tickets set required_service_ids=$1 where id=$2',[[service,second],event]);
   await edit([second]);
   const rows=await query('select benefit_kind,status,result from booking_benefit_selections where booking_id=$1 order by benefit_kind',[booking]);
   assert.equal(rows[0].status,'pending');assert.equal(rows[1].status,'cancelled');assert.equal(rows[1].result.cancellationReason,'booking_services_changed');
   assert.equal((await query("select status from point_tickets where ticket_id='QA-POINT'"))[0].status,'available');
   assert.equal((await query('select stamps from point_balances where member_id=$1 and point_card_id=$2',[member,card]))[0].stamps,50);
   await assert.rejects(redeem('points',['QA-POINT'],'QA-WRONG-SERVICE'),/BOOKING_BENEFIT_SERVICE_REQUIRED/);
  });
  await t.test('all matching, stale member payload and reselection preserve atomic semantics',async()=>{
   await query("update event_tickets set required_service_match_mode='all' where id=$1",[event]);
   await query('select replace_booking_benefit_selections_request($1,$2,$3)',[booking,member,JSON.stringify([{kind:'points',id:'QA-POINT'},{kind:'event',id:'QA-CLAIM'}])]);
   assert.equal((await query("select count(*)::int n from booking_benefit_selections where booking_id=$1 and status='pending'",[booking]))[0].n,0);
   await edit([service,second]);
   await query('select replace_booking_benefit_selections_request($1,$2,$3)',[booking,member,JSON.stringify([{kind:'points',id:'QA-POINT'},{kind:'event',id:'QA-CLAIM'}])]);
   assert.equal((await query("select count(*)::int n from booking_benefit_selections where booking_id=$1 and status='pending'",[booking]))[0].n,2);
   await query('select replace_booking_benefit_selections_request($1,$2,\'[]\')',[booking,member]);
  });
  await t.test('expiry, insufficient points and mixed invalid batches roll back without consumption',async()=>{
   await query('update point_balances set stamps=0 where member_id=$1 and point_card_id=$2',[member,card]);
   await assert.rejects(redeem('points',['QA-POINT'],'QA-NO-POINTS'),/INSUFFICIENT_POINTS/);
   await query('update point_balances set stamps=50 where member_id=$1 and point_card_id=$2',[member,card]);
   await query("update point_cards set expiry_mode='date',expires_on=current_date-1 where id=$1",[card]);
   await assert.rejects(redeem('points',['QA-POINT'],'QA-EXPIRED'),/POINT_CARD_EXPIRED/);
   await query("update point_cards set expiry_mode='unlimited',expires_on=null where id=$1",[card]);
   await query("insert into point_tickets(ticket_id,member_id,point_card_id,ticket_template_id,threshold_stamps,ticket_type,ticket_title) values('QA-POINT-TWO',$1,$2,$3,5,'coupon','QA second coupon')",[member,card,template]);
   await assert.rejects(redeem('points',['QA-POINT','QA-POINT-TWO'],'QA-BATCH-LIMIT'),/TICKET_BATCH_LIMIT_EXCEEDED/);
   await query("delete from point_tickets where ticket_id='QA-POINT-TWO'");
   await assert.rejects(redeem('points',['QA-POINT','FOREIGN-OR-MISSING'],'QA-INVALID-BATCH'),/BOOKING_BENEFIT_SERVICE_REQUIRED/);
   assert.equal((await query("select status from point_tickets where ticket_id='QA-POINT'"))[0].status,'available');
   assert.equal((await query('select stamps from point_balances where member_id=$1 and point_card_id=$2',[member,card]))[0].stamps,50);
   assert.equal((await query('select count(*)::int n from booking_ticket_usage_requests'))[0].n,0);
  });
  await t.test('redemption binds the actual booking and replays once without consuming tickets or points twice',async()=>{
   await query('update event_ticket_settings set max_tickets_per_day=0');
   const result=await redeem('points',['QA-POINT'],'QA-USE-POINT-1');assert.ok(result);
   const replays=await Promise.all([redeem('points',['QA-POINT'],'QA-USE-POINT-1'),redeem('points',['QA-POINT'],'QA-USE-POINT-1')]);assert.ok(replays.every(result=>result.alreadyApplied===true));
   await assert.rejects(redeem('event',['QA-CLAIM'],'QA-USE-POINT-1'),/REQUEST_ID_CONFLICT/);
   await redeem('event',['QA-CLAIM'],'QA-USE-EVENT-1');
   assert.equal((await query('select stamps from point_balances where member_id=$1 and point_card_id=$2',[member,card]))[0].stamps,45);
   assert.equal((await query("select count(*)::int n from booking_ticket_usage_requests where member_id=$1",[member]))[0].n,2);
   await assert.rejects(edit([second]),/BOOKING_REDEEMED_BENEFIT_SERVICE_REQUIRED/);
  });
  await t.test('completion skips already redeemed tickets and terminal retries cannot spend again',async()=>{
   const completion=(await query("select complete_booking_with_benefits_request(id,updated_at,'test:admin','QA') result from bookings where id=$1",[booking]))[0].result;
   assert.equal(completion.serviceMinutes,60);assert.equal(completion.redemptions.length,2);
   assert.equal((await query('select stamps from point_balances where member_id=$1 and point_card_id=$2',[member,card]))[0].stamps,45);
   assert.equal((await redeem('points',['QA-POINT'],'QA-USE-POINT-1')).alreadyApplied,true);
   for(const [kind,refs]of [['points',['QA-POINT']],['event',['QA-CLAIM']]])await assert.rejects(redeem(kind,refs,'QA-TERMINAL-'+kind),/BOOKING_TICKET_CONFIRMATION_REQUIRED/);
   await assert.rejects(query("select complete_booking_with_benefits_request(id,updated_at,'test:admin','QA') from bookings where id=$1",[booking]),/INVALID_BOOKING_TRANSITION/);
   assert.equal((await query('select count(*)::int n from booking_completion_settlements where booking_id=$1',[booking]))[0].n,1);
  });
  await t.test('public roles cannot invoke privileged eligibility, reconciliation or redemption',async()=>{
   for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(options(),/permission denied/);await assert.rejects(redeem('points',['QA-POINT'],'QA-USE-POINT-1'),/permission denied/);await db.exec('reset role');}
  });
  await t.test('deleting an isolated booking removes replay metadata without touching the other member',async()=>{
   await query('delete from booking_completion_settlements where booking_id=$1',[booking]);
   await query('delete from bookings where id=$1',[booking]);assert.equal((await query('select count(*)::int n from booking_ticket_usage_requests'))[0].n,0);
   assert.equal((await query('select status from members where id=$1',[other]))[0].status,'active');
  });
 }finally{await db.close();}
});
