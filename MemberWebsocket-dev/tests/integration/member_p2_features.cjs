const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const load=require('./fixtures/load-postgres-snapshot.cjs');
test('settings copy, consented friends and delegated settlement use canonical PostgreSQL',async t=>{
 const db=await load();const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 try{
  const dependencyCheck=fs.readFileSync(path.resolve(__dirname,'../../supabase/verify_api_dependencies.sql'),'utf8');
  assert.equal((await db.query(dependencyCheck)).rows.some(row=>row.missing_rpc==='member_ticket_booking_options'),true);
  for(const name of ['20261006023020_booking_ticket_usage_consistency.sql','20261006081433_booking_primary_requirement_fixed_notification_time.sql','20261006133127_member_p2_features.sql'])await db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations',name),'utf8'));
  assert.deepEqual((await db.query(dependencyCheck)).rows,[]);
  await db.exec('select maintenance.ensure_required_system_baseline();');
  await db.exec("insert into admins(line_user_id,role,status)values('test:p2-admin','admin','active');");
  const member=async code=>(await one("insert into members(line_user_id,member_code,invite_code,status,membership_status,is_test_account,display_name)values($1,$2,$3,'active','active',true,'QA member')returning id",['test:p2-'+code,code,(code+'0000000000').slice(0,10)])).id;
  const a=await member('AAAA'),b=await member('BBBB'),c=await member('CCCC');
  const friend=async(actor,op,code)=>(await one('select member_friend_action($1,$2,$3) result',['test:p2-'+actor,op,code])).result;
  await t.test('friend request, acceptance authority, repeated actions, removal and block',async()=>{
   await assert.rejects(friend('AAAA','request','AAAA'),/SELF_FRIEND/);
   await assert.rejects(friend('AAAA','lookup','MISSING'),/FRIEND_NOT_FOUND/);
   assert.equal((await friend('AAAA','lookup','BBBB000000')).memberCode,'BBBB');
   assert.equal((await friend('AAAA','request','BBBB')).status,'pending');
   assert.equal((await friend('AAAA','request','BBBB')).alreadyApplied,true);
   await assert.rejects(friend('AAAA','accept','BBBB'),/FRIEND_ACCEPT_DENIED/);
   assert.equal((await friend('BBBB','accept','AAAA')).status,'accepted');
   assert.equal((await friend('BBBB','accept','AAAA')).alreadyApplied,true);
   assert.equal((await friend('AAAA','list','')).friends[0].status,'accepted');
   await friend('CCCC','request','BBBB');await friend('BBBB','block','CCCC');
   await assert.rejects(friend('CCCC','request','BBBB'),/FRIEND_BLOCKED/);
   await assert.rejects(friend('CCCC','remove','BBBB'),/FRIEND_BLOCKED/);
   await friend('BBBB','remove','CCCC');
  });
  const card=(await one("insert into point_cards(card_id,title,status,created_by,updated_by)values('QA-P2-CARD','QA card','active','test:p2-admin','test:p2-admin')returning id")).id;
  const template=(await one("insert into ticket_templates(ticket_template_id,title,ticket_type,status,created_by,updated_by)values('QA-P2-TICKET','QA ticket','coupon','active','test:p2-admin','test:p2-admin')returning id")).id;
  await db.query("insert into point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id)values('QA-P2-RW',$1,5,$2)",[card,template]);
  await db.exec("insert into event_tickets(event_ticket_id,title,ticket_type,status,starts_on,ends_on,created_by,updated_by)values('QA-P2-EVENT','QA event','coupon','active',current_date,current_date+7,'test:p2-admin','test:p2-admin');");
  const copy=async(kind,id,req,title='QA copy')=>(await one('select copy_admin_settings($1,$2,$3,$4,$5) result',['test:p2-admin',kind,id,title,req])).result;
  await t.test('three copies stay draft, children use new IDs, retry is stable, no assets or notifications',async()=>{
   const cloned=await copy('card','QA-P2-CARD','COPY-QA-CARD-0001');
   assert.equal(cloned.status,'draft');assert.equal((await copy('card','QA-P2-CARD','COPY-QA-CARD-0001')).publicId,cloned.publicId);
   await assert.rejects(copy('card','QA-P2-CARD','COPY-QA-CARD-0001','different'),/REQUEST_ID_CONFLICT/);
   const reward=await one('select r.*,t.status from point_card_rewards r join point_cards c on c.id=r.point_card_id join ticket_templates t on t.id=r.ticket_template_id where c.card_id=$1',[cloned.publicId]);
   assert.notEqual(reward.ticket_template_id,template);assert.equal(reward.status,'draft');assert.equal(reward.threshold_stamps,5);
   await db.query('update ticket_templates set title=$1 where id=$2',['independent',reward.ticket_template_id]);assert.equal((await one('select title from ticket_templates where id=$1',[template])).title,'QA ticket');
   for(const [kind,id,table,key] of [['ticket','QA-P2-TICKET','ticket_templates','ticket_template_id'],['event','QA-P2-EVENT','event_tickets','event_ticket_id']]){const copied=await copy(kind,id,'COPY-QA-'+kind+'-0001');assert.equal((await one(`select status from ${table} where ${key}=$1`,[copied.publicId])).status,'draft');}
   const fixed=(await one("insert into fixed_ticket_templates(fixed_ticket_id,title,status,schedule_type,created_by,updated_by,notify_line,calendar_enabled)values('QA-P2-FIXED','QA fixed','archived','birthday_month','test:p2-admin','test:p2-admin',true,true)returning id")).id;const clonedFixed=await copy('fixed','QA-P2-FIXED','COPY-QA-FIXED-0001');const fixedRow=await one('select status,notify_line,calendar_enabled from fixed_ticket_templates where fixed_ticket_id=$1',[clonedFixed.publicId]);assert.deepEqual(fixedRow,{status:'draft',notify_line:false,calendar_enabled:false});
   for(const table of ['point_balances','point_entries','point_tickets','event_ticket_claims','scheduled_grant_messages'])assert.equal((await one(`select count(*)::int n from ${table}`)).n,0);
   await assert.rejects(one("select copy_admin_settings('test:unauthorized','card','QA-P2-CARD','QA','COPY-INVALID-0001')"),/ADMIN_REQUIRED/);
  });
  await db.exec("insert into booking_service_types(name)values('QA P2 service');");
  const type=(await one("select id from booking_service_types where name='QA P2 service'")).id;
  await db.query('insert into booking_service_type_rewards(service_type_id,point_card_id,minutes_per_point)values($1,$2,30)',[type,card]);
  const svc=(await one("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by)values('QA friend service',60,100,'QA P2 service','test:p2-admin')returning id")).id;
  const tech=(await one('select primary_technician_id id from booking_settings where id=1')).id;
  const participants=JSON.stringify([{technicianId:tech,items:[{serviceId:svc,quantity:1}]}]);
  const create=async(code,id,parts=participants,startTime='10:00')=>(await one("select (create_friend_booking_request('test:p2-AAAA',$1,$2,current_date+3,$4::time,$3,'QA','custom','QA','mr','0912345678','[]')).id id",[code,id,parts,startTime])).id;
  await t.test('only accepted friends and one service recipient can be booked; recipient cannot be forged or changed on retry',async()=>{
   await assert.rejects(create('CCCC','BOOK-QA-NOFRIEND'),/FRIEND_ACCEPTED_REQUIRED/);
   await assert.rejects(create('BBBB','BOOK-QA-MULTI',JSON.stringify(JSON.parse(participants).concat(JSON.parse(participants)))),/FRIEND_SINGLE_RECIPIENT/);
  });
  const booking=await create('BBBB','BOOK-QA-FRIEND-0001');
  assert.equal(await create('BBBB','BOOK-QA-FRIEND-0001'),booking);
  await assert.rejects(create('BBBB','BOOK-QA-FRIEND-0001',JSON.stringify([{technicianId:tech,items:[{serviceId:svc,quantity:2}]}])),/REQUEST_ID_CONFLICT/);
  await friend('AAAA','request','CCCC');await friend('CCCC','accept','AAAA');await assert.rejects(create('CCCC','BOOK-QA-FRIEND-0001'),/REQUEST_ID_CONFLICT/);
  await t.test('creation has no rewards; completion credits the friend normally and actor only the delegate bonus once',async()=>{
   assert.equal((await one('select count(*)::int n from friend_booking_rewards')).n,0);
   await db.query("update bookings set status='confirmed' where id=$1",[booking]);
   const result=(await one("select complete_booking_with_rewards_request(id,updated_at,'test:p2-admin') result from bookings where id=$1",[booking])).result;
   assert.equal(result.serviceMinutes,60);assert.equal(result.friendRewardMinutes,30);
   assert.equal((await one('select stamps from point_balances where member_id=$1 and point_card_id=$2',[a,card])).stamps,1);
   assert.equal((await one('select stamps from point_balances where member_id=$1 and point_card_id=$2',[b,card])).stamps,2);
   assert.equal((await one('select sum(minutes)::int n from service_time_entries where member_id=$1',[a])).n,30);
   assert.equal((await one('select sum(minutes)::int n from service_time_entries where member_id=$1',[b])).n,60);
   await assert.rejects(one("select complete_booking_with_rewards_request(id,updated_at,'test:p2-admin') from bookings where id=$1",[booking]),/INVALID_BOOKING_TRANSITION/);
   assert.equal((await one('select count(*)::int n from friend_booking_rewards')).n,1);
   assert.equal((await friend('BBBB','list','')).receivedBookings[0].statusLabel,'已完成');
  });
  await t.test('cancelled delegate bookings cannot issue bonuses',async()=>{const id=await create('BBBB','BOOK-QA-CANCEL-0001',JSON.stringify([{technicianId:tech,items:[{serviceId:svc,quantity:1}]}]),'13:00');await db.query("select request_booking_cancellation(id,member_id,'test:p2-AAAA',updated_at) from bookings where id=$1",[id]);await db.query("select review_booking_cancellation(id,updated_at,'test:p2-admin','approved') from bookings where id=$1",[id]);await assert.rejects(one("select complete_booking_with_rewards_request(id,updated_at,'test:p2-admin') from bookings where id=$1",[id]),/INVALID_BOOKING_TRANSITION/);assert.equal((await one('select count(*)::int n from friend_booking_rewards')).n,1);});
  await t.test('member direct database RPC calls are denied',async()=>{for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(db.query("select member_friend_action('test:p2-AAAA','list','')"),/permission denied/);await assert.rejects(db.query("select copy_admin_settings('test:p2-admin','card','QA-P2-CARD','QA','COPY-DENIED-0001')"),/permission denied/);await db.exec('reset role');}});
 }finally{await db.close();}
});
