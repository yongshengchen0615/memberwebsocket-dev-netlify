const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const database=require('./database.cjs');
const fixture=require('../business-runtime-fixture.cjs');
const migration=fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations/20261029194400_admin_phone_overlapping_booking.sql'),'utf8');
const actor='U'+'5'.repeat(32);
const service='50000000-0000-4000-8000-000000000099';
const args=(id,date,time='10:00')=>[id,actor,date,time,'陳','ms','0912345678',
  JSON.stringify([{serviceId:service,quantity:1}]),'電話預約'];
const serviceItems=JSON.stringify([{serviceId:service,quantity:1}]);
const signature='(text,text,date,time without time zone,text,text,text,jsonb,text)';

test('AC-001/002/003: active reservations reject phone conflicts until cancelled, including concurrent writes',async()=>{
 const h=await fixture({...await database()});
 try{
  const tenant=await h.approve(actor,'phone-'+crypto.randomUUID().slice(0,8));
  await h.db.exec(migration); // Isolated PG17: provision an existing merchant first.
  const s=tenant.runtime_schema;
  const date=(await h.db.query("select ((now() at time zone 'Asia/Taipei')::date+5)::text d")).rows[0].d;
  await h.db.query("insert into "+s+".booking_service_types(name) values('Phone services')");
  await h.db.query("insert into "+s+".booking_services(id,title,duration_minutes,price_amount,is_active,service_type) values($1,'Phone service',30,100,true,'Phone services')",[service]);
  const tech=(await h.db.query("insert into "+s+".booking_technicians(name,is_active) values('QA technician',true) returning id")).rows[0].id;
  await h.db.query("update "+s+".booking_settings set primary_technician_id=$1",[tech]);
  const member=(await h.db.query(
    "insert into "+s+".members(line_user_id,display_name,member_code,membership_status,status) values($1,'Online member','PHONE-TEST-1','active','active') returning id",
    ['U'+'6'.repeat(32)]
  )).rows[0].id;
  const online=(id,time='10:00')=>h.db.query("select ("+s+".create_booking_bundle_request($1,$2,$3,$4,$5,$6)).id",
    [id,member,date,time,serviceItems,'']);
  const call=p=>h.db.query("select ("+s+".admin_create_phone_booking_request($1,$2,$3,$4,$5,$6,$7,$8,$9)).*",p);
  const first=(await online('BOOK-'+crypto.randomUUID())).rows[0].id;
  assert.ok(first);
  const request='PHONE-'+crypto.randomUUID(),p=args(request,date);
  await assert.rejects(call([p[0],'U'+'9'.repeat(32),...p.slice(2)]),/ADMIN_REQUIRED/);
  await assert.rejects(call(p),/PHONE_BOOKING_CONFLICT/);
  await assert.rejects(call(args('PHONE-'+crypto.randomUUID(),date,'10:30')),/PHONE_BOOKING_CONFLICT/);
  assert.equal((await h.db.query("select count(*)::int n from "+s+".bookings")).rows[0].n,1);
  // The administrator must cancel the original booking BEFORE creating a new one.
  await h.db.query("update "+s+".bookings set status='cancelled',cancelled_by=$1,cancelled_at=clock_timestamp() where id=$2",[actor,first]);
  const created=(await call(p)).rows[0];
  assert.equal(created.status,'confirmed');
  assert.equal(created.member_id,null);
  assert.equal(created.technician_id,null);
  assert.equal(created.confirmed_by,actor);
  assert.equal((await call(p)).rows[0].id,created.id); // Idempotency
  await assert.rejects(call([...p.slice(0,6),'0987654321',...p.slice(7)]),/REQUEST_ID_CONFLICT/);
  await assert.rejects(call(args('PHONE-'+crypto.randomUUID(),date,'10:00')),/PHONE_BOOKING_CONFLICT/);
  // Member request cannot bypass the telephone reservation through the old RPC.
  await assert.rejects(online('BOOK-'+crypto.randomUUID()),/BOOKING_SLOT_TAKEN/);
  const result=(await h.db.query(
    "select (select count(*)::int from "+s+".booking_items where booking_id=$1) as items,"
    +"(select count(*)::int from "+s+".booking_audit_events where target_id=$1::text and action='BOOKING_PHONE_CREATED') as audits",
    [created.id]
  )).rows[0];
  assert.deepEqual(result,{items:2,audits:1});
  await h.db.query("update "+s+".bookings set status='cancelled',cancelled_by=$1,cancelled_at=clock_timestamp() where id=$2",[actor,created.id]);
  assert.ok((await online('BOOK-'+crypto.randomUUID())).rows[0].id);
  // A fresh tenant must inherit both the function and database trigger.
  const fresh=await h.approve('U'+'7'.repeat(32),'phone-fresh-'+crypto.randomUUID().slice(0,8));
  assert.ok((await h.db.query('select to_regprocedure($1) fn',
    [fresh.runtime_schema+'.admin_create_phone_booking_request'+signature])).rows[0].fn);
  assert.equal((await h.db.query("select count(*)::int n from pg_trigger where tgrelid=$1::regclass and tgname='bookings_phone_no_overlap'",
    [fresh.runtime_schema+'.bookings'])).rows[0].n,1);
  const rights=(await h.db.query(
    "select has_function_privilege('anon',$1,'EXECUTE') a,has_function_privilege('service_role',$1,'EXECUTE') s",
    [s+'.admin_create_phone_booking_request'+signature]
  )).rows[0];
  assert.deepEqual(rights,{a:false,s:true});
 }finally{await h.db.close();}
});

test('AC-002 concurrency: simultaneous telephone requests for same free slot commit at most one',async()=>{
 const h=await fixture({...await database()});
 try{
  const tenant=await h.approve(actor,'phone-race-'+crypto.randomUUID().slice(0,8));
  await h.db.exec(migration);
  const s=tenant.runtime_schema;
  const date=(await h.db.query("select ((now() at time zone 'Asia/Taipei')::date+5)::text d")).rows[0].d;
  await h.db.query("insert into "+s+".booking_service_types(name) values('Phone services')");
  await h.db.query("insert into "+s+".booking_services(id,title,duration_minutes,price_amount,is_active,service_type) values($1,'Phone service',30,100,true,'Phone services')",[service]);
  const c1=await h.db.connect(),c2=await h.db.connect();
  const sql="select ("+s+".admin_create_phone_booking_request($1,$2,$3,$4,$5,$6,$7,$8,$9)).id";
  const result=await Promise.allSettled([
    c1.query(sql,args('PHONE-'+crypto.randomUUID(),date,'12:00')),
    c2.query(sql,args('PHONE-'+crypto.randomUUID(),date,'12:00'))
  ]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(result.filter(x=>x.status==='rejected'&&/PHONE_BOOKING_CONFLICT/.test(x.reason?.message)).length,1);
  assert.equal((await h.db.query("select count(*)::int n from "+s+".bookings where booking_date=$1 and start_time='12:00' and status='confirmed'",[date])).rows[0].n,1);
 }finally{await h.db.close();}
});
