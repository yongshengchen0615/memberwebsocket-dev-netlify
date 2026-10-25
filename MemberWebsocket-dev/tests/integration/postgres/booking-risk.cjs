const test=require('node:test'),assert=require('node:assert/strict');
const database=require('./database.cjs');
const baseSetup=require('../fixtures/booking-event-setup.cjs');
const {register,helpers}=require('../fixtures/booking-risk-cases.cjs');
const setup=async options=>baseSetup({...await database(),...options});
register(test,setup,'PostgreSQL 17 TCP');

async function waitForLock(h,client){
 const pid=(await client.query('select pg_backend_pid() pid')).rows[0].pid;
 return async()=>{
  for(let attempt=0;attempt<100;attempt++){
   const row=(await h.db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0];
   if(row?.wait_event_type==='Lock')return;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('EXPECTED_SECOND_CONNECTION_LOCK_WAIT');
 };
}
test('PostgreSQL 17: two physical sessions count a duplicate no-show exactly once',async()=>{
 const h=await setup();try{
  const x=await helpers(h);await x.enable();await x.save({threshold_count:1});
  const b=await x.past(await h.make()),version=(await h.state(b)).updated_at;
  const a=await h.db.connect(),c=await h.db.connect(),blocked=await waitForLock(h,c);
  assert.notEqual((await a.query('select pg_backend_pid() p')).rows[0].p,(await c.query('select pg_backend_pid() p')).rows[0].p);
  const sql=`select ${h.s}.admin_mark_booking_no_show($1,$2,$3,'Synthetic race') r`,args=[h.owner,b,version];
  await a.query('begin');await a.query(sql,args);
  const second=c.query(sql,args);second.catch(()=>{});
  await blocked();await a.query('commit');assert.equal((await second).rows[0].r.alreadyApplied,true);
  assert.equal((await h.q('select count(*)::int n from S.booking_no_show_events'))[0].n,1);
  assert.equal((await h.q('select count(*)::int n from S.booking_restrictions'))[0].n,1);
  assert.equal((await h.q("select count(*)::int n from S.booking_audit_events where action='BOOKING_NO_SHOW'"))[0].n,1);
 }finally{await h.db.close();}
});
test('PostgreSQL 17: a create waiting on the member lock observes the committed restriction',async()=>{
 const h=await setup();try{
  const x=await helpers(h);await x.enable();await x.save({threshold_count:1});
  const b=await x.past(await h.make());
  const a=await h.db.connect(),c=await h.db.connect(),blocked=await waitForLock(h,c);
  await a.query('begin');await a.query(`select ${h.s}.admin_mark_booking_no_show($1,$2,$3,'Synthetic race')`,[h.owner,b,(await h.state(b)).updated_at]);
  const create=c.query(`select ${h.s}.create_group_booking_request_v2($1,$2,current_date+3,'10:00',$3,'')`,['RACE-'+crypto.randomUUID(),h.m,JSON.stringify([{technicianId:null,items:[{serviceId:h.svc,quantity:1}]}])]);
  create.catch(()=>{});await blocked();await a.query('commit');await assert.rejects(create,/BOOKING_RESTRICTED/);
  assert.equal((await h.q('select count(*)::int n from S.bookings'))[0].n,1);
 }finally{await h.db.close();}
});
test('PostgreSQL 17: distinct simultaneous no-shows reach one threshold without duplicate restrictions',async()=>{
 const h=await setup();try{
  const x=await helpers(h);await x.enable();const one=await x.past(await h.make()),two=await x.past(await h.make());
  const a=await h.db.connect(),c=await h.db.connect();
  // Both BEFORE member_removal_guard triggers may hold KEY SHARE before either
  // AFTER risk trigger upgrades its mutex. Force that real interleaving here.
  await Promise.all([a,c].map(async client=>{await client.query('begin');await client.query(`select id from ${h.s}.members where id=$1 for key share`,[h.m]);}));
  await Promise.all([[a,one],[c,two]].map(async([client,b])=>{
   try{await client.query(`select ${h.s}.admin_mark_booking_no_show($1,$2,$3,'Distinct race')`,[h.owner,b,(await h.state(b)).updated_at]);await client.query('commit');}
   catch(error){await client.query('rollback');throw error;}
  }));
  assert.equal((await h.q('select count(*)::int n from S.booking_no_show_events'))[0].n,2);
  assert.equal((await h.q('select count(*)::int n from S.booking_restrictions'))[0].n,1);assert.equal((await x.status()).restricted,true);
 }finally{await h.db.close();}
});
test('PostgreSQL 17: competing notification claims and rollback preserve durable unique work',async()=>{
 const h=await setup();try{
  const b=await h.make(),a=await h.db.connect(),c=await h.db.connect();
  const claims=await Promise.all([a.query(`select * from ${h.s}.claim_booking_notifications(20)`),c.query(`select * from ${h.s}.claim_booking_notifications(20)`)]);
  assert.equal(claims.reduce((n,r)=>n+r.rowCount,0),1);assert.equal((await h.q('select count(*)::int n from S.notice_outbox'))[0].n,1);
  await a.query('begin');await a.query(`update ${h.s}.bookings set status='confirmed' where id=$1`,[b]);await a.query('rollback');
  assert.equal((await h.state(b)).status,'pending');assert.equal((await h.q('select count(*)::int n from S.notice_outbox'))[0].n,1);
 }finally{await h.db.close();}
});
test('PostgreSQL 17: existing-tenant upgrade and pg_dump/pg_restore preserve row types, risk data, RLS and constraints',async()=>{
 const fs=require('node:fs'),path=require('node:path'),fixture=require('../business-runtime-fixture.cjs');
 const h=await fixture({...await database(),beforeEventRepair:true});
 try{
  const owner='U'+'2'.repeat(32),t=await h.approve(owner,'upgrade-restore'),s=t.runtime_schema;
  const m=(await h.db.query(`insert into ${s}.members(line_user_id,member_code,invite_code,status,membership_status,is_test_account)values($1,'RESTORE-MEMBER','ABCD987654','active','active',true) returning id`,['U'+'3'.repeat(32)])).rows[0].id;
  const signature=s+'.admin_update_booking_participant_items_request(uuid,timestamptz,text,jsonb)';
  const originalType=(await h.db.query('select prorettype::oid result from pg_proc where oid=$1::regprocedure',[signature])).rows[0].result;
  await h.db.exec('set search_path=public,extensions');
  for(const name of ['20261021045559_booking_notification_event_repair.sql','20261021045611_booking_no_show_policy.sql','20261021060609_booking_risk_appeal_resolution.sql','20261021061400_booking_risk_member_lock.sql','20261025125207_booking_risk_record_context.sql'])await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations',name),'utf8'));
  assert.equal((await h.db.query('select prorettype::oid result from pg_proc where oid=$1::regprocedure',[signature])).rows[0].result,originalType);
  await h.db.query(`update ${s}.booking_no_show_policy set contact_text='Restore marker'`);
  const before=(await h.db.query(`select (select count(*)::int from ${s}.members) members,(select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind='r' and c.relrowsecurity) rls`,[s])).rows[0];
  const {client,checksum}=await h.db.backupRestore();assert.match(checksum,/^[a-f0-9]{64}$/);
  assert.deepEqual((await client.query(`select (select count(*)::int from ${s}.members) members,(select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind='r' and c.relrowsecurity) rls`,[s])).rows[0],before);
  assert.equal((await client.query(`select member_code from ${s}.members where id=$1`,[m])).rows[0].member_code,'RESTORE-MEMBER');
  assert.equal((await client.query(`select contact_text,enabled from ${s}.booking_no_show_policy`)).rows[0].contact_text,'Restore marker');
  assert.equal((await client.query(`select enabled from ${s}.booking_no_show_policy`)).rows[0].enabled,false);
  await client.query('set role anon');await assert.rejects(client.query(`select * from ${s}.booking_restrictions`),/permission denied/);await client.query('reset role');
  await assert.rejects(client.query(`insert into ${s}.booking_no_show_events(booking_id,member_id,occurred_at,marked_by)values($1,$2,now(),'synthetic')`,[crypto.randomUUID(),m]),/foreign key/);
  // A new business approved after restore must still run both installers.
  const app=(await client.query('select public.platform_submit_application($1,$2,$3) a',['U'+'5'.repeat(32),'After restore','after-restore'])).rows[0].a;
  const features=Object.fromEntries(['membership','points','events','calendar','integrations','booking','testing','usage'].map(key=>[key,true]));
  const restored=(await client.query('select public.platform_approve_application($1,$2,$3,$4) t',[h.root,app.id,features,crypto.randomUUID()])).rows[0].t;
  assert.equal((await client.query(`select enabled from ${restored.runtime_schema}.booking_no_show_policy`)).rows[0].enabled,false);
 }finally{await h.db.close();}
});
