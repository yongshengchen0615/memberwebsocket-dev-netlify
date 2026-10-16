const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const load=require('./fixtures/load-postgres-snapshot.cjs'),root=path.resolve(__dirname,'../..');
const migration='20261014043730_booking_notifications_noshow_readable_audit.sql';
test('no-show and readable audit retain PostgreSQL integrity and authorization',async t=>{
 const db=await load(),q=async(sql,args=[]) => (await db.query(sql,args)).rows,one=async(sql,args=[]) => (await q(sql,args))[0];
 try {
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261006023020_booking_ticket_usage_consistency.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations/20261013043627_member_booking_selections_and_audit_query.sql'),'utf8'));
  await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',migration),'utf8'));
  await db.exec('select maintenance.ensure_required_system_baseline();select maintenance.ensure_event_ticket_settings_baseline();');
  await db.exec("insert into admins(line_user_id,role,status) values('QA:admin','admin','active'),('QA:revoked','none','pending');");
  const m=(await one("insert into members(line_user_id,member_code,status,membership_status,is_test_account,phone,surname,salutation,birthday) values('QA:member','QA-MEMBER','active','active',true,'+886912345678','王','mr','1990-01-01') returning id")).id;
  const receiver=(await one("insert into members(line_user_id,member_code,status,membership_status,is_test_account) values('QA:receiver','QA-RECEIVER','active','active',true) returning id")).id;
  await db.exec("insert into booking_service_types(name) values('QA');");
  const svc=(await one("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by) values('QA service',30,100,'QA','QA:admin') returning id")).id;
  const newBooking=async req=>(await one("select (create_booking_bundle_request($1,$2,current_date+3,$4,$3,'')).id id",[req,m,JSON.stringify([{serviceId:svc,quantity:1},{serviceId:'00000000-0000-4000-8000-000000000010',quantity:1}]),req.endsWith('0002') ? '13:00' : '10:00'])).id;
  const b=await newBooking('BOOK-QA-NOSHOW-0001');
  const future=await newBooking('BOOK-QA-NOSHOW-0002');
  const version=async id=>(await one('select updated_at from bookings where id=$1',[id])).updated_at;
  const mark=async(id=b,actor='QA:admin',v=null)=>(await one('select admin_mark_booking_no_show($1,$2,$3,$4) result',[actor,id,v || await version(id),'QA人工核對'])).result;
  await t.test('early, forged, non-admin and revoked calls reject',async()=>{
   await assert.rejects(mark(),/BOOKING_NO_SHOW_TOO_EARLY/);
   await assert.rejects(mark(b,'QA:member'),/ADMIN_REQUIRED/);await assert.rejects(mark(b,'QA:revoked'),/ADMIN_REQUIRED/);
   await assert.rejects(mark('00000000-0000-4000-8000-999999999999','QA:admin',new Date()),/BOOKING_NOT_FOUND/);
   for(const rpc of ['admin_mark_booking_no_show(text,uuid,timestamptz,text)','record_member_card_open(text)','save_member_profile_audited(text,timestamptz,jsonb)','operation_audit_safe_detail(text,text,text,jsonb)'])
    assert.equal((await one("select has_function_privilege('anon',$1,'execute') a,has_function_privilege('authenticated',$1,'execute') u",[rpc])).a,false);
  });
  await db.exec('alter table bookings disable trigger booking_enforce_advance_window;alter table bookings disable trigger bookings_zz_enforce_live_clock');
  await q('update bookings set booking_date=current_date-1 where id=$1',[b]);
  await db.exec('alter table bookings enable trigger booking_enforce_advance_window;alter table bookings enable trigger bookings_zz_enforce_live_clock');
  const card=(await one("insert into point_cards(card_id,title,status,created_by,updated_by) values('QA-CARD','QA集點卡','active','QA:admin','QA:admin') returning id")).id;
  const template=(await one("insert into ticket_templates(ticket_template_id,title,ticket_type,status,created_by,updated_by) values('QA-TEMPLATE','QA票券','coupon','active','QA:admin','QA:admin') returning id")).id;
  await q('insert into point_balances(member_id,point_card_id,stamps) values($1,$2,20)',[m,card]);
  await q("insert into point_tickets(ticket_id,member_id,point_card_id,ticket_template_id,threshold_stamps,ticket_type,ticket_title) values('QA-TICKET',$1,$2,$3,5,'coupon','QA票券'),('QA-TICKET-2',$1,$2,$3,5,'coupon','未來票券')",[m,card,template]);
  await q("insert into booking_benefit_selections(booking_id,member_id,benefit_kind,benefit_ref,title_snapshot) values($1,$2,'points','QA-TICKET','QA票券'),($3,$2,'points','QA-TICKET-2','未來票券')",[b,m,future]);
  await t.test('audit failure rolls back status and ticket release',async()=>{
   await db.exec("create function qa_fail_audit() returns trigger language plpgsql as $$begin if new.action='BOOKING_NO_SHOW' then raise exception 'QA_FAIL';end if;return new;end$$;create trigger qa_fail before insert on booking_audit_events for each row execute function qa_fail_audit();");
   await assert.rejects(mark(),/QA_FAIL/);
   assert.equal((await one('select status from bookings where id=$1',[b])).status,'pending');
   assert.equal((await one('select status from booking_benefit_selections where booking_id=$1',[b])).status,'pending');
   await db.exec('drop trigger qa_fail on booking_audit_events');
  });
  await t.test('simultaneous retries are once; no debit or redemption and other bookings stay intact',async()=>{
   const v=await version(b); const results=await Promise.all([mark(b,'QA:admin',v),mark(b,'QA:admin',v)]);
   assert.equal(results.filter(x=>!x.alreadyApplied).length,1);
   assert.equal((await one("select count(*)::int n from booking_audit_events where action='BOOKING_NO_SHOW'")).n,1);
   assert.equal((await one('select stamps from point_balances where member_id=$1',[m])).stamps,20);
   assert.equal((await one("select status from point_tickets where ticket_id='QA-TICKET'")).status,'available');
   assert.equal((await one('select status from booking_benefit_selections where booking_id=$1',[b])).status,'cancelled');
   assert.equal((await one('select status from booking_benefit_selections where booking_id=$1',[future])).status,'pending');
   assert.equal((await one('select count(*)::int n from booking_completion_settlements where booking_id=$1',[b])).n,0);
   assert.equal((await one("select count(*)::int n from booking_notifications.outbox where booking_id=$1 and event_key like '%no_show%'",[b])).n,0);
  });
  await t.test('snapshot, terminal state and stale version do not bypass transition',async()=>{
   await q("update bookings set request_id='receipt-register:QA-NOSHOW-SNAPSHOT' where id=$1",[future]);
   await assert.rejects(mark(future),/BOOKING_NO_SHOW_NOT_ALLOWED/);
   await q("update bookings set request_id='BOOK-QA-NOSHOW-0002',status='confirmed' where id=$1",[future]);
   await assert.rejects(mark(future),/BOOKING_NO_SHOW_NOT_ALLOWED/);
  });
  await t.test('selection audit preserves the event ticket title after later reservation edits',async()=>{
   const v=await version(future);
   await q("select member_update_booking_benefits_request('QA:member',$1,$2,'BSEL-QA-AUDIT-TITLE','[{\"kind\":\"points\",\"id\":\"QA-TICKET-2\"}]')",[future,v]);
   const event=await one("select metadata from booking_audit_events where action='BOOKING_BENEFITS_UPDATED' and target_id=$1",[future]);
   await q("update booking_benefit_selections set title_snapshot='LATER-TITLE' where booking_id=$1",[future]);
   const safe=await one("select operation_audit_safe_detail('BOOKING_BENEFITS_UPDATED','booking',$1,$2) detail",[future,JSON.stringify(event.metadata)]);
   assert.equal(safe.detail.ticketTitle,'QA集點卡｜未來票券');
  });
  await t.test('card open deduplication and atomic profile audit never expose field values',async()=>{
   await q("select record_member_card_open('QA:member')");await q("select record_member_card_open('QA:member')");
   assert.equal((await one("select count(*)::int n from audit_logs where action='MEMBER_CARD_OPEN'")).n,1);
   const v=(await one('select updated_at from members where id=$1',[m])).updated_at;
   await q("select save_member_profile_audited('QA:member',$1,'{\"surname\":\"陳\"}')",[v]);
   await q("select save_member_profile_audited('QA:member',$1,'{\"surname\":\"陳\"}')",[v]);
   const logs=await q("select detail from audit_logs where action='MEMBER_PROFILE_UPDATED'");assert.equal(logs.length,1);assert.deepEqual(logs[0].detail,{profileFields:['surname']});
   await assert.rejects(q("select save_member_profile_audited('QA:member',$1,'{\"surname\":\"林\"}')",[v]),/PROFILE_CONFLICT/);
   await assert.rejects(q("select record_member_card_open('QA:other')"),/MEMBERSHIP_REQUIRED/);
  });
  await t.test('transfer query includes both parties and only safe metadata, unknown payload is hidden',async()=>{
   await q("insert into point_transfers(transfer_id,request_id,sender_member_id,receiver_member_id,point_card_id,amount) values('QA-TRANSFER','QA-TRANSFER-REQ',$1,$2,$3,3)",[m,receiver,card]);
   await db.exec("insert into audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail) values('QA-TRANS-AUDIT','QA:member','member','user.pointcard.transfer','point_transfer','QA-TRANSFER','success','{\"token\":\"DO-NOT-EXPOSE\",\"password\":\"SECRET\"}');");
   const read=async code=>(await one("select admin_query_operation_audit('QA:admin',now()-interval '1 day',now()+interval '1 day',$1,'user.pointcard.transfer','',null,'',50,'AUDQ-QA-20261014') result",[code])).result;
   const data=await read('QA-RECEIVER');assert.equal(data.items.length,1);assert.equal(data.items[0].detail.amount,3);assert.ok(data.items[0].detail.sender);assert.ok(data.items[0].detail.receiver);
   assert.doesNotMatch(JSON.stringify(data),/DO-NOT-EXPOSE|SECRET|token|password/);
   await assert.rejects(q("select admin_query_operation_audit('QA:member',now()-interval '1 day',now()+interval '1 day','','','',null,'',50,'AUDQ-QA-20261014')"),/ADMIN_REQUIRED/);
  });
 } finally { await db.close(); }
});
