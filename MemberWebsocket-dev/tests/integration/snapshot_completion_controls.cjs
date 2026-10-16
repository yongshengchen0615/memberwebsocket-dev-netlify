const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const load=require('./fixtures/load-postgres-snapshot.cjs');
const migration='20261010084712_membership_snapshot_and_completion_controls.sql';
test('ticket policy, snapshot intent/review and append-only order corrections use PostgreSQL transactions',async t=>{
 const db=await load();const one=async(q,args=[]) => (await db.query(q,args)).rows[0];
 const run=(q,args=[])=>db.query(q,args);
 try{
  for(const name of ['20261006023020_booking_ticket_usage_consistency.sql','20261006081433_booking_primary_requirement_fixed_notification_time.sql','20261006133127_member_p2_features.sql','20261010021829_snapshot_location_policy.sql',migration,'20261010145511_snapshot_tickets_without_advance_booking.sql','20261012092000_snapshot_location_restriction_error.sql','20261012095000_snapshot_configurable_geofence.sql']) await db.exec(fs.readFileSync(path.join(__dirname,'../../supabase/migrations',name),'utf8'));
  await db.exec("select maintenance.ensure_required_system_baseline();select maintenance.ensure_event_ticket_settings_baseline();insert into admins(line_user_id,role,status)values('test:controls-admin','admin','active');");
  const member=(await one("insert into members(line_user_id,member_code,status,membership_status,is_test_account,surname,salutation,phone)values('test:controls-member','QA-CONTROLS','active','active',true,'測試','mr','+886912345678')returning id")).id;
  const other=(await one("insert into members(line_user_id,member_code,status,membership_status,is_test_account)values('test:controls-other','QA-OTHER','active','active',true)returning id")).id;
  const type=(await one("insert into booking_service_types(name)values('Controls QA')returning id")).id;
  const card=(await one("insert into point_cards(card_id,title,status,expiry_mode,created_by,updated_by)values('QA-CONTROLS-CARD','QA card','active','unlimited','test:controls-admin','test:controls-admin')returning id")).id;
  await run('insert into booking_service_type_rewards(service_type_id,point_card_id,minutes_per_point)values($1,$2,30)',[type,card]);
  const service=(await one("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by)values('QA service',60,100,'Controls QA','test:controls-admin')returning id")).id;
  const otherService=(await one("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by)values('QA alternative',30,100,'Controls QA','test:controls-admin')returning id")).id;
  const store='00000000-0000-4000-8000-000000000010';
  const create=async key=>(await one("select (create_booking_bundle_request($1,$2,'2099-01-01','10:00',$3,'QA')).id id",[key,member,JSON.stringify([{serviceId:service,quantity:1},{serviceId:store,quantity:1}])])).id;
  const booking=await create('QA-CONTROLS-BOOKING');
  // Simulate time elapsing after a valid reservation; production triggers remain enabled for every tested operation.
  await db.exec('alter table bookings disable trigger user');await run("update bookings set status='confirmed',booking_date='2026-01-31' where id=$1",[booking]);await db.exec('alter table bookings enable trigger user');
  const template=(await one("insert into ticket_templates(ticket_template_id,title,ticket_type,status,created_by,updated_by)values('QA-CONTROLS-TEMPLATE','Coupon','coupon','active','test:controls-admin','test:controls-admin')returning id")).id;
  const reward=(await one("insert into point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id)values('QA-CONTROLS-REWARD',$1,5,$2)returning id",[card,template])).id;
  await run('insert into point_balances(member_id,point_card_id,stamps)values($1,$2,50)',[member,card]);
  await run("insert into point_tickets(ticket_id,member_id,point_card_id,reward_id,ticket_template_id,threshold_stamps,ticket_type,ticket_title)values('QA-CONTROLS-POINT',$1,$2,$3,$4,5,'coupon','QA coupon')",[member,card,reward,template]);
  const event=(await one("insert into event_tickets(event_ticket_id,title,ticket_type,status,starts_on,ends_on,created_by,updated_by)values('QA-CONTROLS-EVENT','QA event','coupon','active',(clock_timestamp()at time zone'Asia/Taipei')::date-1,(clock_timestamp()at time zone'Asia/Taipei')::date+1,'test:controls-admin','test:controls-admin')returning id")).id;
  const snapshotEvent=(await one("insert into event_tickets(event_ticket_id,title,ticket_type,status,starts_on,ends_on,created_by,updated_by)values('QA-SNAPSHOT-EVENT','QA snapshot event','coupon','active',(clock_timestamp()at time zone'Asia/Taipei')::date-1,(clock_timestamp()at time zone'Asia/Taipei')::date+1,'test:controls-admin','test:controls-admin')returning id")).id;
  for(const ref of ['QA-CONTROLS-CLAIM','QA-SNAPSHOT-CLAIM'])await run("insert into event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title)values($1,$2,$3,'coupon','QA event')",[ref,ref.includes('SNAPSHOT')?snapshotEvent:event,member]);
  await db.exec('update event_ticket_settings set max_tickets_per_day=0 where id=1');
  const save=async(value,actor='test:controls-admin',expected=null)=>(await one("select (save_booking_shared_settings_v6('09:00','17:00',30,0,0,'',10,false,'18:00',$1,$2,false,$3)).ticket_booking_required required",[expected,actor,value])).required;
  const redeem=async(kind,refs,key,book=null,line='test:controls-member',location=null)=>(await one('select redeem_member_tickets_for_booking_request($1,$2,$3,$4,$5,$6) result',[line,book,kind,refs,key,location])).result;
  await t.test('default ON, authorization, stale settings and old clients preserve the policy',async()=>{
   assert.equal((await one('select ticket_booking_required required from booking_settings')).required,true);
   await assert.rejects(save(false,'test:controls-member'),/ADMIN_REQUIRED/);
   await assert.rejects(save(false,'test:controls-admin','2000-01-01'),/BOOKING_SETTINGS_CONFLICT/);
   await assert.rejects(redeem('points',['QA-CONTROLS-POINT'],'QA-NO-BOOKING'),/BOOKING_TICKET_CONFIRMATION_REQUIRED/);
   assert.equal(await save(false),false);assert.equal(await save(null),false);
  });
  await t.test('OFF only removes booking precondition; ownership, services, GPS and request replay remain enforced',async()=>{
   const choices=(await one('select member_ticket_booking_options($1)result',[member])).result;
   assert.ok(choices.points['QA-CONTROLS-POINT'].some(b=>b.bookingId==='no-booking'));
   await run('update point_card_rewards set required_service_ids=$1 where id=$2',[[service],reward]);
   await assert.rejects(redeem('points',['QA-CONTROLS-POINT'],'QA-SERVICE-REJECT'),/BOOKING_BENEFIT_SERVICE_REQUIRED/);
   await run("update point_card_rewards set required_service_ids='{}' where id=$1",[reward]);
   await redeem('points',['QA-CONTROLS-POINT'],'QA-POINT-DIRECT');
   assert.equal((await redeem('points',['QA-CONTROLS-POINT'],'QA-POINT-DIRECT')).alreadyApplied,true);
   await run("update event_tickets set requires_location=true,redemption_locations='[{\"id\":\"qa\",\"name\":\"QA\",\"latitude\":25.033,\"longitude\":121.5654,\"radiusMeters\":100}]' where id=$1",[event]);
   await assert.rejects(redeem('event',['QA-CONTROLS-CLAIM'],'QA-GPS-REJECT'),/LOCATION/);
   await run("update event_tickets set requires_location=false,redemption_locations='[]' where id=$1",[event]);
   await assert.rejects(redeem('event',['QA-CONTROLS-CLAIM'],'QA-OWNER-REJECT',null,'test:controls-other'),/BOOKING_BENEFIT_SERVICE_REQUIRED/);
   await redeem('event',['QA-CONTROLS-CLAIM'],'QA-CLAIM-DIRECT');
   assert.equal((await redeem('event',['QA-CONTROLS-CLAIM'],'QA-CLAIM-DIRECT')).alreadyApplied,true);
   await assert.rejects(redeem('event',['QA-SNAPSHOT-CLAIM'],'QA-CLAIM-DIRECT'),/REQUEST_ID_CONFLICT/);
  });
  let receipt;
  const benefits=[{kind:'event',id:'QA-SNAPSHOT-CLAIM'}];
  const prepare=async(key,values=benefits,owner=member,book=null)=>(await one("select prepare_snapshot_receipt_v2($1,$2,$3,'image/jpeg',100,null,$4,$5)result",[owner,key,`${owner}/accessible/${key}.jpg`,JSON.stringify(values),book])).result;
  const finalize=async(id=receipt,owner=member)=>(await one("select finalize_snapshot_receipt_v2($1,$2,'test:controls-member','image/jpeg',100,$3,null)result",[id,owner,'a'.repeat(64)])).result;
  await t.test('snapshot submits without booking but normal redemption still needs one',async()=>{
   await save(true);
   await assert.rejects(redeem('event',['QA-SNAPSHOT-CLAIM'],'QA-DIRECT-BLOCKED'),/BOOKING_TICKET_CONFIRMATION_REQUIRED/);
   // A location-only ticket is not a missing/expired ticket. Snapshot upload
   // must identify the actual GPS restriction, independently of booking policy.
   await run("update event_tickets set requires_location=true,redemption_locations='[{\"id\":\"qa\",\"name\":\"QA\",\"latitude\":25.033,\"longitude\":121.5654,\"radiusMeters\":100}]' where id=$1",[snapshotEvent]);
   try { await assert.rejects(prepare('QA-SNAPSHOT-GPS-REJECT'),/BOOKING_BENEFIT_LOCATION_REQUIRED/); }
   finally { await run("update event_tickets set requires_location=false,redemption_locations='[]' where id=$1",[snapshotEvent]); }
   receipt=(await prepare('QA-SNAPSHOT-REQUEST')).receiptId;
   assert.equal((await one('select requested_booking_id from booking_receipts where receipt_id=$1',[receipt])).requested_booking_id,null);
   assert.equal((await one("select status from event_ticket_claims where claim_id='QA-SNAPSHOT-CLAIM'")).status,'claimed');
   await assert.rejects(prepare('QA-SNAPSHOT-REQUEST',[]),/REQUEST_ID_CONFLICT/);
   await assert.rejects(finalize(receipt,other),/RECEIPT_NOT_OWNED/);
   assert.equal(await save(true),true);
   await run("update event_tickets set ends_on=(clock_timestamp()at time zone'Asia/Taipei')::date-1 where id=$1",[snapshotEvent]);
   await assert.rejects(finalize(),/BOOKING_BENEFIT_NOT_AVAILABLE/);
   await run("update event_tickets set ends_on=(clock_timestamp()at time zone'Asia/Taipei')::date+1 where id=$1",[snapshotEvent]);
   assert.equal((await finalize()).status,'awaiting_review');assert.equal((await finalize()).alreadyApplied,true);
  });
  await t.test('member can withdraw only its own pending request; replay is harmless',async()=>{
   const version=(await one('select updated_at from booking_receipts where receipt_id=$1',[receipt])).updated_at;
   const cancel=(owner=member,actor='test:controls-member')=>one('select cancel_snapshot_receipt_request($1,$2,$3,$4)result',[receipt,owner,actor,version]);
   await assert.rejects(cancel(other,'test:controls-other'),/RECEIPT_NOT_OWNED/);
   await cancel();assert.equal((await cancel()).result.alreadyApplied,true);
   receipt=(await prepare('QA-SNAPSHOT-REQUEST-SECOND')).receiptId;await finalize();
   await one("select dismiss_accessible_receipt_request($1,updated_at,'test:controls-admin') from booking_receipts where receipt_id=$1",[receipt]);
   receipt=(await prepare('QA-SNAPSHOT-REQUEST-THIRD')).receiptId;await finalize();
  });
  await t.test('admin approves once through canonical settlement and anonymous roles cannot access new writes',async()=>{
   const approve=async actor=>(await one("select register_snapshot_receipt_v2($1,updated_at,$2,$3,null,null,'[]',$4,'QA approval')result from booking_receipts where receipt_id=$1",[receipt,actor,booking,JSON.stringify(benefits)])).result;
   await assert.rejects(approve('test:controls-member'),/ADMIN_REQUIRED/);
   await approve('test:controls-admin');assert.equal((await approve('test:controls-admin')).alreadyApplied,true);
   assert.equal((await one("select status from event_ticket_claims where claim_id='QA-SNAPSHOT-CLAIM'")).status,'used');
   for(const role of ['anon','authenticated']){
    await db.exec('set role '+role);await assert.rejects(save(false),/permission denied/);await assert.rejects(prepare('QA-DENIED'),/permission denied/);await db.exec('reset role');
   }
  });
  const participants=minutes=>[{position:1,items:[{serviceId:service,quantity:1,minutes}]}];
  const correction=async(key,values,apply=false,expected=null,actor='test:controls-admin',version=null)=>(await one("select correct_completed_booking_request($1,coalesce($2,updated_at),$3,$4,'QA correction',$5,$6,$7)result from bookings where id=$1",[booking,version,actor,key,JSON.stringify(values),apply,expected])).result;
  const totals=async()=>({points:Number((await one('select stamps from point_balances where member_id=$1 and point_card_id=$2',[member,card])).stamps),minutes:Number((await one('select coalesce(sum(minutes),0)::int n from service_time_entries where member_id=$1',[member])).n),adjustments:(await one('select count(*)::int n from booking_completion_adjustments')).n});
  await t.test('preview leaves no writes; positive/negative corrections append deltas and replay once',async()=>{
   const before=await totals();const original=(await one('select service_minutes from booking_completion_settlements where booking_id=$1',[booking])).service_minutes;
   const up=await correction('QA-CORRECT-UP',participants(120));assert.equal(up.serviceMinutesDelta,60);assert.deepEqual(await totals(),before);
   await correction('QA-CORRECT-UP',participants(120),true,up);
   assert.equal((await correction('QA-CORRECT-UP',participants(120),true,up)).alreadyApplied,true);
   await assert.rejects(correction('QA-CORRECT-UP',participants(60),true,up),/REQUEST_ID_CONFLICT/);
   const down=await correction('QA-CORRECT-DOWN',participants(30));assert.equal(down.serviceMinutesDelta,-90);await correction('QA-CORRECT-DOWN',participants(30),true,down);
   assert.equal((await totals()).minutes,before.minutes-30);assert.equal((await totals()).points,before.points-1);
   assert.equal((await one('select service_minutes from booking_completion_settlements where booking_id=$1',[booking])).service_minutes,original);
  });
  await t.test('unauthorized, stale preview/version, invalid input and write failures preserve all ledgers',async()=>{
   const before=await totals();const oldVersion=(await one('select updated_at from bookings where id=$1',[booking])).updated_at;
   await assert.rejects(correction('QA-CORRECT-DENIED',participants(60),false,null,'test:controls-member'),/ADMIN_REQUIRED/);
   await assert.rejects(correction('QA-CORRECT-STALE',participants(60),true,{}),/CORRECTION_PREVIEW_STALE/);
   await assert.rejects(correction('QA-CORRECT-VERSION',participants(60),false,null,'test:controls-admin','2000-01-01'),/BOOKING_CONFLICT/);
   await assert.rejects(correction('QA-CORRECT-INVALID',participants(-1)),/INVALID_BOOKING_ITEMS/);
   const preview=await correction('QA-CORRECT-FAIL',participants(60));
   await db.exec("create function public.qa_adjust_fail()returns trigger language plpgsql as $$begin raise exception 'QA_WRITE_FAIL';end$$;create trigger qa_adjust_fail before insert on booking_completion_adjustments for each row execute function public.qa_adjust_fail();");
   await assert.rejects(correction('QA-CORRECT-FAIL',participants(60),true,preview),/QA_WRITE_FAIL/);
   assert.deepEqual(await totals(),before);assert.deepEqual((await one('select updated_at from bookings where id=$1',[booking])).updated_at,oldVersion);
   await db.exec('drop trigger qa_adjust_fail on booking_completion_adjustments;');
   for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(correction('QA-CORRECT-CLIENT',participants(60)),/permission denied/);await db.exec('reset role');}
  });

  await t.test('zero delta, changed service, preserved historical price and exhausted points remain consistent',async()=>{
   const before=await totals();const noop=await correction('QA-CORRECT-NOOP',participants(30));
   assert.equal(noop.serviceMinutesDelta,0);assert.deepEqual(noop.pointDeltas,[]);
   await correction('QA-CORRECT-NOOP',participants(30),true,noop);
   assert.equal((await totals()).points,before.points);assert.equal((await totals()).minutes,before.minutes);
   const changed=[{position:1,items:[{serviceId:otherService,quantity:1,minutes:30}]}];
   const change=await correction('QA-CORRECT-SERVICE',changed);await correction('QA-CORRECT-SERVICE',changed,true,change);
   assert.equal((await one('select count(*)::int n from booking_participant_items where service_id=$1',[service])).n,0);
   await run('update booking_services set price_amount=999 where id=$1',[otherService]);
   const retained=await correction('QA-CORRECT-HISTORICAL',changed);await correction('QA-CORRECT-HISTORICAL',changed,true,retained);
   assert.equal((await one('select unit_price_amount from booking_participant_items where service_id=$1',[otherService])).unit_price_amount,100);
   await run('update point_balances set stamps=0 where member_id=$1 and point_card_id=$2',[member,card]);
   await assert.rejects(correction('QA-CORRECT-EXHAUSTED',[{position:1,items:[]}]),/INSUFFICIENT_POINTS/);
   assert.equal((await totals()).minutes,30);
   await run('update point_balances set stamps=$3 where member_id=$1 and point_card_id=$2',[member,card,before.points]);
   const empty=await correction('QA-CORRECT-ZERO',[{position:1,items:[]}]);assert.equal(empty.after.serviceMinutes,0);
   await correction('QA-CORRECT-ZERO',[{position:1,items:[]}],true,empty);assert.equal((await totals()).minutes,0);
   assert.equal((await one('select count(*)::int n from service_time_entries where member_id=$1',[other])).n,0);
  });
  await t.test('two writes with the same version yield one correction and preserve another member',async()=>{
   const version=(await one('select updated_at from bookings where id=$1',[booking])).updated_at;
   const preview=await correction('QA-CONCURRENT-FIRST',participants(30));
   const results=await Promise.allSettled([
    correction('QA-CONCURRENT-FIRST',participants(30),true,preview,'test:controls-admin',version),
    correction('QA-CONCURRENT-SECOND',participants(30),true,preview,'test:controls-admin',version)
   ]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   assert.match(String(results.find(r=>r.status==='rejected').reason),/BOOKING_CONFLICT/);
   assert.equal((await one('select count(*)::int n from point_entries where member_id=$1',[other])).n,0);
  });
   await t.test('snapshot review creates retrospective booking and consumes ticket without prior reservation',async()=>{
    const separateEvent=(await one("insert into event_tickets(event_ticket_id,title,ticket_type,status,starts_on,ends_on,created_by,updated_by)values('QA-SNAPSHOT-NO-BOOKING-EVENT','QA extra snapshot event','coupon','active',(clock_timestamp()at time zone'Asia/Taipei')::date-1,(clock_timestamp()at time zone'Asia/Taipei')::date+1,'test:controls-admin','test:controls-admin')returning id")).id;
    await run("insert into event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title)values('QA-SNAPSHOT-NO-BOOKING',$1,$2,'coupon','QA snapshot no booking')",[separateEvent,member]);
    const newBenefits=[{kind:'event',id:'QA-SNAPSHOT-NO-BOOKING'}];
    // Snapshot submission and review are independent of the NORMAL
    // redemption booking policy, even when an admin flips it in between.
    assert.equal(await save(false),false);
    const newReceipt=(await prepare('QA-NO-ADVANCE-BOOKING',newBenefits)).receiptId;
    assert.equal((await finalize(newReceipt)).status,'awaiting_review');
    assert.equal(await save(true),true);
    await run('update booking_settings set require_primary_technician=false where id=1');
    const items=[{serviceId:service,quantity:1,minutes:60}];
    const result=(await one("select register_snapshot_receipt_v2($1,updated_at,'test:controls-admin',null,'2026-01-01','12:00',$2,$3,'QA retrospective review') result from booking_receipts where receipt_id=$1",[newReceipt,JSON.stringify(items),JSON.stringify(newBenefits)])).result;
    assert.ok(result.bookingId);
    assert.equal((await one('select status from event_ticket_claims where claim_id=$1',['QA-SNAPSHOT-NO-BOOKING'])).status,'used');
    assert.equal((await one('select booking_id from booking_receipts where receipt_id=$1',[newReceipt])).booking_id,result.bookingId);
    assert.equal((await one('select ticket_booking_required as enabled from booking_settings where id=1')).enabled,true);
   });
 }finally{await db.close();}
});
