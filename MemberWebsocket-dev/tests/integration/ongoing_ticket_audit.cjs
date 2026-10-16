const {test}=require('node:test'); const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'); const load=require('./fixtures/load-postgres-snapshot.cjs');
const root=path.resolve(__dirname,'../..');
test('member ticket intent and admin audit use protected PostgreSQL transactions',async t=>{
 const db=await load(); const q=async(sql,args=[]) => (await db.query(sql,args)).rows; const one=async(sql,args=[]) => (await q(sql,args))[0];
 try{
  for(const name of ['20261006023020_booking_ticket_usage_consistency.sql','20261002210000_booking_point_reservation_balance.sql','20261012100000_snapshot_mode_ticket_geofence_proof.sql','20261012133000_booking_selection_without_gps.sql','20261013043627_member_booking_selections_and_audit_query.sql']) await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8'));
  await db.exec('select maintenance.ensure_required_system_baseline();select maintenance.ensure_event_ticket_settings_baseline();');
  await db.exec("insert into admins(line_user_id,role,status) values('QA:admin','admin','active'),('QA:pending','none','pending');");
  const m=(await one("insert into members(line_user_id,member_code,status,membership_status,is_test_account) values('QA:member','QA-MEMBER','active','active',true) returning id")).id;
  const card=(await one("insert into point_cards(card_id,title,status,created_by,updated_by) values('QA-CARD','QA card','active','QA:admin','QA:admin') returning id")).id;
  const template=(await one("insert into ticket_templates(ticket_template_id,title,ticket_type,status,created_by,updated_by) values('QA-TEMPLATE','QA coupon','coupon','active','QA:admin','QA:admin') returning id")).id;
  await db.exec("insert into booking_service_types(name) values('QA');");
  const svc=(await one("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by) values('QA service',30,100,'QA','QA:admin') returning id")).id;
  const reward=(await one("insert into point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id,required_service_ids) values('QA-REWARD',$1,5,$2,$3) returning id",[card,template,[svc]])).id;
  await q('insert into point_balances(member_id,point_card_id,stamps) values($1,$2,20)',[m,card]);
  await q("insert into point_tickets(ticket_id,member_id,point_card_id,reward_id,ticket_template_id,threshold_stamps,ticket_type,ticket_title,requires_location) values('QA-TICKET',$1,$2,$3,$4,5,'coupon','QA coupon',true),('QA-TICKET-2',$1,$2,null,$4,5,'coupon','QA coupon 2',true)",[m,card,reward,template]);
  const event=(await one("insert into event_tickets(event_ticket_id,title,ticket_type,status,created_by,updated_by,requires_location,redemption_locations) values('QA-EVENT','QA event','coupon','active','QA:admin','QA:admin',true,'[{\"name\":\"QA\",\"latitude\":25.03,\"longitude\":121.56,\"radiusMeters\":100}]') returning id")).id;
  await q("insert into event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title) values('QA-CLAIM',$1,$2,'coupon','QA event')",[event,m]);
  const b=(await one("select (create_booking_bundle_request('BOOK-QA-AUDIT-0001',$1,current_date+3,'10:00',$2,'')).id id",[m,JSON.stringify([{serviceId:svc,quantity:1},{serviceId:'00000000-0000-4000-8000-000000000010',quantity:1}])])).id;
  // Model elapsed service time in the isolated fixture; restore the scheduling guard before exercising any API.
  await db.exec('alter table bookings disable trigger booking_enforce_advance_window;alter table bookings disable trigger bookings_zz_enforce_live_clock');
  await q("update bookings set status='confirmed',booking_date=current_date-1 where id=$1",[b]);
  await db.exec('alter table bookings enable trigger booking_enforce_advance_window;alter table bookings enable trigger bookings_zz_enforce_live_clock');
  const version=async()=>(await one('select updated_at from bookings where id=$1',[b])).updated_at;
  const update=async(values,req='BSEL-QA-00000001',v=null,line='QA:member') => (await one('select member_update_booking_benefits_request($1,$2,$3,$4,$5) result',[line,b,v||await version(),req,JSON.stringify(values)])).result;
  const selections=[{kind:'points',id:'QA-TICKET'},{kind:'event',id:'QA-CLAIM'}];
  let first,initialVersion=await version();
  await t.test('ended service remains adjustable before completion, GPS is not needed, replay is once',async()=>{
   first=await update(selections);
   assert.equal(first.alreadyApplied,false);
   const repeats=await Promise.all([update(selections,'BSEL-QA-00000001',initialVersion),update(selections.slice().reverse(),'BSEL-QA-00000001',initialVersion)]);
   assert.ok(repeats.every(x=>x.alreadyApplied));
   assert.equal((await one('select stamps from point_balances where member_id=$1',[m])).stamps,20);
   assert.equal((await one("select count(*)::int n from booking_audit_events where action='BOOKING_BENEFITS_UPDATED'")).n,1);
   assert.equal((await one("select count(*)::int n from booking_benefit_selections where booking_id=$1 and status='pending'",[b])).n,2);
  });
  await t.test('ownership, version, count, balance and malformed payload reject atomically',async()=>{
   await assert.rejects(update([],'BSEL-QA-FOREIGN01',null,'QA:other'),/BOOKING_NOT_OWNED/);
   await assert.rejects(update([],'BSEL-QA-CONFLICT1',initialVersion),/BOOKING_CONFLICT/);
   await assert.rejects(update([],'BSEL-QA-00000001'),/REQUEST_ID_CONFLICT/);
   await assert.rejects(update([{kind:'points',id:'QA-TICKET'},{kind:'points',id:'QA-TICKET-2'}],'BSEL-QA-LIMIT001'),/BOOKING_POINT_TICKET_LIMIT_EXCEEDED/);
   await assert.rejects(update([{kind:'points',id:'QA-TICKET'},{kind:'points',id:'QA-TICKET'}],'BSEL-QA-DUPLICATE'),/INVALID_BOOKING_BENEFITS/);
   await assert.rejects(update([{kind:'points',id:'FOREIGN'}],'BSEL-QA-NOTFOUND'),/BOOKING_BENEFIT_SERVICE_REQUIRED/);
   assert.equal((await one('select count(*)::int n from booking_benefit_change_requests')).n,1);
  });
  await t.test('remove releases reservations; insufficient points and expiration cannot be reselected',async()=>{
   await update([],'BSEL-QA-REMOVE01');
   assert.equal((await one("select count(*)::int n from booking_benefit_selections where booking_id=$1 and status='pending'",[b])).n,0);
   await q('update point_balances set stamps=0 where member_id=$1',[m]);
   await assert.rejects(update(selections,'BSEL-QA-NOPOINTS'),/POINT_TICKET_INSUFFICIENT_POINTS/);
   await q('update point_balances set stamps=20 where member_id=$1',[m]);
   await q("update point_cards set expiry_mode='date',expires_on=current_date-1 where id=$1",[card]);
   await assert.rejects(update(selections,'BSEL-QA-EXPIRED1'),/BOOKING_BENEFIT_NOT_AVAILABLE/);
   await q("update point_cards set expiry_mode='unlimited',expires_on=null where id=$1",[card]);
   await update(selections,'BSEL-QA-RESTORE1');
  });
  await t.test('audit failure rolls back mutation; two simultaneous versions cannot overwrite each other',async()=>{
   const before=await version();
   await db.exec("create function public.qa_reject_audit() returns trigger language plpgsql as $$begin if new.action='BOOKING_BENEFITS_UPDATED' then raise exception 'QA_AUDIT_UNAVAILABLE'; end if; return new;end$$;create trigger qa_reject_audit before insert on booking_audit_events for each row execute function public.qa_reject_audit();");
   await assert.rejects(update([],'BSEL-QA-AUDITFAIL'),/QA_AUDIT_UNAVAILABLE/);
   assert.deepEqual(await version(),before);assert.equal((await one("select count(*)::int n from booking_benefit_selections where booking_id=$1 and status='pending'",[b])).n,2);
   assert.equal((await one("select count(*)::int n from booking_benefit_change_requests where request_id='BSEL-QA-AUDITFAIL'")).n,0);
   await db.exec('drop trigger qa_reject_audit on booking_audit_events');
   const writes=await Promise.allSettled([update([],'BSEL-QA-CONCURRENT1',before),update(selections,'BSEL-QA-CONCURRENT2',before)]);
   assert.equal(writes.filter(x=>x.status==='fulfilled').length,1);assert.match(writes.find(x=>x.status==='rejected').reason.message,/BOOKING_CONFLICT/);
   await update(selections,'BSEL-QA-FINALRESTORE');
  });
  await t.test('final completion and edit race serialize; terminal writes cannot reopen the selection',async()=>{
   const v=await version();
   const settled=(await one("select complete_booking_with_benefits_request($1,$2,'QA:admin','') result",[b,v])).result;
   assert.ok(settled);
   await assert.rejects(update([],'BSEL-QA-TERMINAL'),/BOOKING_NOT_EDITABLE/);
   assert.equal((await one('select stamps from point_balances where member_id=$1',[m])).stamps,15);
   assert.equal((await update(selections,'BSEL-QA-FINALRESTORE')).alreadyApplied,true);
   assert.equal((await one('select stamps from point_balances where member_id=$1',[m])).stamps,15);
  });
  const audit=async(actor='QA:admin',before=null,member='',action='',result='',limit=2,id='AUDQ-QA-00000001') => (await one("select admin_query_operation_audit($1,now()-interval '2 days',now()+interval '1 day',$2,$3,$4,$5,$6,$7,$8) result",[actor,member,action,result,before?.createdAt||null,before?.id||'',limit,id])).result;
  await t.test('admin audit combines sources, redacts secrets and allows deterministic filtered pages',async()=>{
   await q("insert into audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,detail) values('QA-SECRET','QA:member','member','LOGIN_SESSION_CREATED','member','QA:member','failed',$1)",[JSON.stringify({password:'NEVER-EXPOSE',token:'NEVER-EXPOSE',secret:'NEVER-EXPOSE',phone:'0912345678',requestId:'QA-request',selectedCount:2})]);
   const filtered=await audit('QA:admin',null,'QA-MEMBER','LOGIN_SESSION_CREATED','failed');
   assert.equal(filtered.items.length,1);assert.equal(filtered.items[0].result,'failed');
   assert.equal(JSON.stringify(filtered).includes('NEVER-EXPOSE'),false);assert.equal(JSON.stringify(filtered).includes('0912345678'),false);
   const page=await audit();assert.equal(page.items.length,2);assert.equal(page.hasMore,true);
   const next=await audit('QA:admin',page.items.at(-1),'','','',2,'AUDQ-QA-NEXTPAGE');
   assert.ok(next.items.every(x=>!page.items.some(y=>y.id===x.id)));
   assert.equal((await one("select count(*)::int n from audit_logs where action='AUDIT_QUERY_VIEWED' and target_id='AUDQ-QA-00000001'")).n,1);
   assert.equal((await audit('QA:admin',null,'MISSING')).items.length,0);
   await assert.rejects(audit('QA:pending'),/ADMIN_REQUIRED/);await assert.rejects(audit('QA:member'),/ADMIN_REQUIRED/);
  });
  await t.test('retention clears only records older than one year and preserves member rights',async()=>{
   const balance=(await one('select stamps from point_balances where member_id=$1',[m])).stamps;
   await q("insert into audit_logs(audit_id,actor_line_user_id,actor_role,action,target_type,target_id,result,created_at) values('QA-OLD','QA:admin','admin','AUDIT_QUERY_VIEWED','audit_query','QA-OLD','success',now()-interval '366 days')");
   await q("insert into booking_audit_events(actor_line_user_id,actor_role,action,target_type,target_id,result,created_at) values('QA:member','member','BOOKING_BENEFITS_UPDATED','booking',$1,'success',now()-interval '366 days')",[b]);
   assert.equal((await one('select maintenance.prune_operation_audit() n')).n,2);
   assert.equal((await one("select count(*)::int n from audit_logs where audit_id='QA-OLD'")).n,0);
   assert.ok((await one('select count(*)::int n from booking_audit_events')).n>0);
   assert.equal((await one('select stamps from point_balances where member_id=$1',[m])).stamps,balance);
   assert.equal((await one('select count(*)::int n from bookings where id=$1',[b])).n,1);
  });
  await t.test('browser roles cannot read tables or call privileged RPCs directly',async()=>{
   for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(update([],'BSEL-QA-DENIED01'),/permission denied/);await assert.rejects(audit(),/permission denied/);await assert.rejects(q('select * from booking_benefit_change_requests'),/permission denied/);await db.exec('reset role');}
  });
 }finally{await db.close();}
});
