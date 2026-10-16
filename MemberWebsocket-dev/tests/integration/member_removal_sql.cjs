const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const load=require('./fixtures/load-postgres-snapshot.cjs');
test('member removal blocks writes, retries cross-service failures, removes private data and preserves other member assets',async t=>{
 const db=await load();try{
  const exec=name=>db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migrations',name),'utf8'));
  for(const name of ['20261006023020_booking_ticket_usage_consistency.sql','20261006081433_booking_primary_requirement_fixed_notification_time.sql','20261006133127_member_p2_features.sql','20261008034343_admin_service_item_grants.sql','20261008075553_single_active_member_login.sql','20261008083358_test_account_duplicate_login_setting.sql','20261008091007_test_login_takeover_single_session.sql','20261005151234_e2e_membership_terms_scope.sql','20261005152023_e2e_membership_terms_target_member.sql'])await exec(name);
  await db.exec('create schema storage;create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);');
  await exec('20261008152922_member_removal_workflow.sql');
  await db.exec("select maintenance.ensure_required_system_baseline();insert into admins(line_user_id,role,status)values('qa-removal-admin','admin','active');");
  const one=async(q,v=[])=>(await db.query(q,v)).rows[0];
  const make=async code=>(await one("insert into members(line_user_id,member_code,invite_code,status,membership_status,display_name,is_test_account)values($1,$2,$3,'active','active','Private member',true)returning id",['qa-removal-'+code,code,code+'000000'])).id;
  const a=await make('AAAA'),b=await make('BBBB');
  const card=(await one("insert into point_cards(card_id,title,status,created_by,updated_by)values('QA-REMOVE-CARD','QA card','active','qa-removal-admin','qa-removal-admin')returning id")).id;
  await db.query('insert into point_balances(member_id,point_card_id,stamps)values($1,$3,10),($2,$3,2)',[a,b,card]);
  await one("select transfer_member_points('qa-removal-AAAA','BBBB','QA-REMOVE-CARD',3,'QA-TRANSFER-REMOVE')");
  await db.query("select member_friend_action('qa-removal-AAAA','request','BBBB')");await db.query("select member_friend_action('qa-removal-BBBB','accept','AAAA')");
  await db.exec("insert into booking_service_types(name)values('QA removal');");
  const svc=(await one("insert into booking_services(title,duration_minutes,price_amount,service_type,created_by)values('QA service',60,100,'QA removal','qa-removal-admin')returning id")).id;
  const tech=(await one('select primary_technician_id id from booking_settings where id=1')).id;
  const parts=JSON.stringify([{technicianId:tech,items:[{serviceId:svc,quantity:1}]}]);
  const shared=(await one("select (create_friend_booking_request('qa-removal-AAAA','BBBB','QA-SHARED-REMOVE',current_date+3,'10:00',$1,'QA','custom','PRIVATE','mr','0912345678','[]')).id id",[parts])).id;
  const removedRecipient=(await one("select (create_friend_booking_request('qa-removal-BBBB','AAAA','QA-RECIPIENT-REMOVE',current_date+4,'10:00',$1,'QA','custom','PRIVATE','mr','0912345678','[]')).id id",[parts])).id;
  await db.query("insert into storage.objects(bucket_id,name)values('booking-receipts',$1)",[a+'/pending/photo.jpg']);
  const begin=async(actor='qa-removal-admin',code='AAAA')=>(await one("select begin_member_removal($1,'qa-removal-AAAA',$2) result",[actor,code])).result;
  const finish=async id=>(await one("select finish_member_removal('qa-removal-admin',$1) result",[id])).result;
  await t.test('authorization and exact confirmation precede every mutation',async()=>{
   await assert.rejects(begin('qa-removal-outsider'),/ADMIN_REQUIRED/);await assert.rejects(begin(undefined,'BBBB'),/CONFIRMATION_MISMATCH/);
   assert.equal((await one('select status from members where id=$1',[a])).status,'active');
   await assert.rejects(one("select begin_member_removal('qa-removal-admin','qa-removal-admin','ADMIN')"),/ADMIN_PROTECTED/);
  });
  const job=await begin();assert.equal(job.state,'deleting');assert.equal((await begin()).jobId,job.jobId);
  await t.test('pending storage failure keeps identity disabled and rejects writes and stale signed uploads',async()=>{
   await assert.rejects(finish(job.jobId),/REMOVAL_STORAGE_PENDING/);
   assert.equal((await one('select status from members where id=$1',[a])).status,'disabled');
   await assert.rejects(db.query('insert into point_balances(member_id,point_card_id,stamps)values($1,$2,1) on conflict(member_id,point_card_id)do update set stamps=1',[a,card]),/MEMBER_REMOVED/);
   await assert.rejects(db.query("insert into storage.objects(bucket_id,name)values('booking-receipts',$1)",[a+'/late/photo.jpg']),/MEMBER_REMOVED/);
   await assert.rejects(db.query("update members set status='active' where id=$1",[a]),/MEMBER_REMOVED/);
  });
  await db.query('delete from storage.objects where name like $1',[a+'/%']);
  const result=await finish(job.jobId);assert.equal(result.state,'complete');assert.equal((await finish(job.jobId)).alreadyApplied,true);
  await t.test('no member FK or private identity remains, receiver balance and ledger remain intact',async()=>{
   assert.equal((await one('select count(*)::int n from members where id=$1',[a])).n,0);
   const fks=(await db.query("select c.relname,a.attname from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_attribute a on a.attrelid=k.conrelid and a.attnum=any(k.conkey) where k.contype='f' and k.confrelid='public.members'::regclass")).rows;
   for(const fk of fks)assert.equal((await one(`select count(*)::int n from ${fk.relname} where ${fk.attname}=$1`,[a])).n,0,fk.relname);
   assert.equal((await one('select stamps from point_balances where member_id=$1 and point_card_id=$2',[b,card])).stamps,5);
   assert.equal((await one('select sum(amount)::int n from point_entries where member_id=$1',[b])).n,3);
   const kept=await one('select member_id,service_recipient_member_id,contact_phone from bookings where id=$1',[shared]);assert.equal(kept.member_id,null);assert.equal(kept.service_recipient_member_id,b);assert.equal(kept.contact_phone,null);
   const cancelled=await one('select member_id,service_recipient_member_id,status from bookings where id=$1',[removedRecipient]);assert.equal(cancelled.member_id,b);assert.equal(cancelled.service_recipient_member_id,null);assert.equal(cancelled.status,'cancelled');
   assert.equal((await one('select sender_member_id from point_transfers')).sender_member_id,null);
   assert.equal((await one('select member_id from member_removal_jobs where id=$1',[job.jobId])).member_id,null);
   await assert.rejects(db.query("insert into storage.objects(bucket_id,name)values('booking-receipts',$1)",[a+'/resurrect/photo.jpg']),/MEMBER_REMOVED/);
   await assert.rejects(one("select member_login_claim('qa-removal-AAAA',$1,$2,1,'login')",['a'.repeat(64),'b'.repeat(64)]),/MEMBER_REMOVED/);
   await one("select member_login_claim('qa-removal-AAAA',$1,$2,$3,'login')",['a'.repeat(64),'b'.repeat(64),Date.now()+10000]);
   const next=await make('AAAA');assert.notEqual(next,a);assert.equal((await one('select count(*)::int n from point_balances where member_id=$1',[next])).n,0);
  });
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(begin(),/permission denied/);await assert.rejects(db.query('select * from member_removal_jobs'),/permission denied/);await db.exec('reset role');}
 }finally{await db.close();}
});
