const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const load=require('./fixtures/load-postgres-snapshot.cjs');
const migration=fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations/20261006081433_booking_primary_requirement_fixed_notification_time.sql'),'utf8');

test('primary technician settings and fixed notification scheduling use canonical PostgreSQL',async t=>{
 const db=await load();
 try {
  await db.exec(migration);
  await db.exec('select maintenance.ensure_required_system_baseline();');
  const rows=async(sql,args=[]) => (await db.query(sql,args)).rows;
  const one=async(sql,args=[]) => (await rows(sql,args))[0];
  const primary=(await one('select primary_technician_id id from booking_settings where id=1')).id;
  const other=(await one("insert into booking_technicians(name,created_by) values('QA secondary','test:admin') returning id")).id;
  const inactive=(await one("insert into booking_technicians(name,is_active,created_by) values('QA disabled',false,'test:admin') returning id")).id;
  const validate=participants=>one('select validate_group_booking_technicians($1) id',[JSON.stringify(participants)]);
  await t.test('legacy default, missing primary, duplicate and disabled technician rejection',async()=>{
   assert.equal((await one('select require_primary_technician value from booking_settings')).value,true);
   await assert.rejects(validate([{technicianId:other}]),/BOOKING_PRIMARY_TECHNICIAN_REQUIRED/);
   await assert.rejects(validate([{technicianId:primary},{technicianId:primary}]),/DUPLICATE_PARTICIPANT_TECHNICIAN/);
   await assert.rejects(validate([{technicianId:primary},{technicianId:inactive}]),/BOOKING_TECHNICIAN_DISABLED/);
   assert.equal((await validate([{technicianId:primary}])).id,primary);
  });
  await t.test('optional primary allows other technician and onsite while still rejecting forged IDs',async()=>{
   await db.exec('update booking_settings set require_primary_technician=false,primary_technician_id=null where id=1');
   assert.equal((await validate([{technicianId:other}])).id,other);
   assert.equal((await validate([{technicianId:null}])).id,null);
   await assert.rejects(validate([{technicianId:inactive}]),/BOOKING_TECHNICIAN_DISABLED/);
   await assert.rejects(validate([{technicianId:'00000000-0000-4000-8000-000000000099'}]),/BOOKING_TECHNICIAN_NOT_FOUND/);
  });
  const member=(await one("insert into members(line_user_id,member_code,status,membership_status,is_test_account) values('test:settings-member','QA-SETTINGS','active','active',true) returning id")).id;
  await db.exec("insert into admins(line_user_id,role,status) values('test:admin','admin','active');insert into booking_service_types(name) values('QA');");
  const service=(await one("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by) values('QA service',30,100,'QA','test:admin') returning id")).id;
  let booking;
  await t.test('onsite creation, changed settings rejection, existing completion and receipt review',async()=>{
   booking=(await one("select (create_group_booking_request_v2('BOOK-QA-OPTIONAL',$1,current_date+3,'10:00',$2,'QA')).id id",[member,JSON.stringify([{technicianId:null,items:[{serviceId:service,quantity:1}]}])])).id;
   assert.equal((await one('select technician_id from bookings where id=$1',[booking])).technician_id,null);
   await rows('update booking_settings set require_primary_technician=true,primary_technician_id=$1 where id=1',[primary]);
   await assert.rejects(validate([{technicianId:null}]),/BOOKING_PRIMARY_TECHNICIAN_REQUIRED/);
   await rows("update bookings set status='confirmed' where id=$1",[booking]);
   const settled=(await one("select complete_booking_with_rewards_request(id,updated_at,'test:admin','QA') result from bookings where id=$1",[booking])).result;
   assert.equal(settled.serviceMinutes,0,'Independent primary-only reward rule is preserved');
   await rows('update booking_settings set require_primary_technician=false,primary_technician_id=null where id=1');
   await rows("insert into booking_receipts(receipt_id,member_id,submission_mode,status,object_path,declared_mime_type,declared_size_bytes,request_id) values('BR-QA-OPTIONAL',$1,'accessible','awaiting_review','qa/receipt.jpg','image/jpeg',100,'QA-RECEIPT-OPTIONAL')",[member]);
   const result=(await one("select register_accessible_receipt_with_benefits_request(receipt_id,updated_at,'test:admin',null,'2020-01-01','10:00',$1,'[]','QA') result from booking_receipts where receipt_id='BR-QA-OPTIONAL'",[JSON.stringify([{serviceId:service,minutes:30,quantity:1}])])).result;
   assert.ok(result.bookingId);
   assert.equal((await one('select technician_id,status from bookings where id=$1',[result.bookingId])).status,'completed');
  });
  const formal=(await one("insert into members(line_user_id,member_code,status,membership_status,is_test_account) values('fixture:formal','QA-FORMAL','active','active',true) returning id")).id;
  await rows('update members set is_test_account=false where id=$1',[formal]);
  const template=(await one("insert into fixed_ticket_templates(fixed_ticket_id,title,status,schedule_type,schedule_weekday,notify_line,created_by,updated_by) values('QA-FIXED-TIME','QA notification','active','weekly',1,true,'fixture:admin','fixture:admin') returning id")).id;
  await t.test('notification time, midnight, disable, enable, retime, eligibility and idempotency',async()=>{
   const issue=()=>one('select issue_fixed_tickets((now() at time zone \'Asia/Taipei\')::date,$1,$2) result',[formal,template]);
   await issue();
   let q=await one('select * from scheduled_grant_messages where member_id=$1',[formal]);
   assert.ok(q.fixed_ticket_grant_id);const id=q.id;
   const gate=async()=> (await one('select fixed_ticket_notification_delivery($1) result',[id])).result;
   await rows("update scheduled_grant_messages set status='sending' where id=$1",[id]);
   assert.equal((await gate()).action,'send');
   await rows("update fixed_ticket_templates set notify_time='23:59' where id=$1",[template]);
   q=await one('select * from scheduled_grant_messages where id=$1',[id]);
   assert.equal(q.status,'pending');
   assert.equal((await one("select scheduled_for >= (notification_business_date+time '23:59') at time zone 'Asia/Taipei' ok from scheduled_grant_messages where id=$1",[id])).ok,true);
   await rows("update fixed_ticket_templates set notify_time='00:00' where id=$1",[template]);
   await rows("update scheduled_grant_messages set status='sending' where id=$1",[id]);
   assert.equal((await gate()).action,'send');
   await rows('update fixed_ticket_templates set notify_line=false where id=$1',[template]);
   assert.equal((await gate()).reason,'FIXED_NOTIFICATION_DISABLED');
   assert.equal((await one('select status from scheduled_grant_messages where id=$1',[id])).status,'cancelled');
   await rows('update fixed_ticket_templates set notify_line=true where id=$1',[template]);
   await rows("update scheduled_grant_messages set status='sending' where id=$1",[id]);
   await rows("update members set status='disabled' where id=$1",[formal]);
   assert.equal((await gate()).reason,'FIXED_MEMBER_INELIGIBLE');
   await rows("update members set status='active' where id=$1",[formal]);
   await rows("update scheduled_grant_messages set scheduled_for=now()+interval '1 day' where id=$1",[id]);
   assert.equal((await gate()).action,'defer');
   await rows("update scheduled_grant_messages set status='sent' where id=$1",[id]);
   await rows('update fixed_ticket_templates set notify_line=false where id=$1',[template]);
   await rows('update fixed_ticket_templates set notify_line=true,notify_time=null where id=$1',[template]);
   await issue();
   q=await one('select * from scheduled_grant_messages where id=$1',[id]);
   assert.equal(q.status,'sent');
   assert.equal((await one('select count(*)::int n from scheduled_grant_messages where member_id=$1',[formal])).n,1);
   await assert.rejects(rows("update fixed_ticket_templates set notify_time='25:00' where id=$1",[template]),/time/);
   await assert.rejects(rows("update fixed_ticket_templates set notify_time='10:30:01' where id=$1",[template]),/fixed_ticket_notify_time_minutes/);
  });
  await t.test('notification delivery RPC denies anonymous and authenticated callers',async()=>{
   for(const role of ['anon','authenticated']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query("select fixed_ticket_notification_delivery(gen_random_uuid())"),/permission denied/);
    await db.exec('reset role');
   }
  });
 } finally {await db.close();}
});
