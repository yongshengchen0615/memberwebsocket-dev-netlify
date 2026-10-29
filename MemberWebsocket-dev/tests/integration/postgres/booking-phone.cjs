const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const database=require('./database.cjs');
const fixture=require('../business-runtime-fixture.cjs');
const migration=fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations/20261029194400_admin_phone_overlapping_booking.sql'),'utf8');
const actor='U'+'5'.repeat(32);
const service='50000000-0000-4000-8000-000000000099';
const args=(id,date)=>[id,actor,date,'10:00','陳','ms','0912345678',JSON.stringify([{serviceId:service,quantity:1}]),'電話預約',true];
test('AC-001/002 PostgreSQL 17: verified phone bookings overlap existing members, retain constraints and idempotency',async()=>{
  const h=await fixture({...await database()});
  try {
    const tenant=await h.approve(actor,'phone-'+crypto.randomUUID().slice(0,8));
    await h.db.exec(migration);
    const s=tenant.runtime_schema;
    const day=(await h.db.query("select ((now() at time zone 'Asia/Taipei')::date+5)::text d")).rows[0].d;
    await h.db.query("insert into "+s+".booking_service_types(name) values('Phone services')");
    await h.db.query("insert into "+s+".booking_services(id,title,duration_minutes,price_amount,is_active,service_type) values($1,'Phone service',30,100,true,'Phone services')",[service]);
    const tech=(await h.db.query("insert into "+s+".booking_technicians(name,is_active) values('QA technician',true) returning id")).rows[0].id;
    await h.db.query("update "+s+".booking_settings set primary_technician_id=$1",[tech]);
    const member=(await h.db.query("insert into "+s+".members(line_user_id,display_name,member_code,membership_status,status) values($1,'Online member','PHONE-TEST-1','active','active') returning id",['U'+'6'.repeat(32)])).rows[0].id;
    const original=(await h.db.query(
      "select ("+s+".create_booking_bundle_request($1,$2,$3,$4,$5,$6)).id",
      ['BOOK-'+crypto.randomUUID(),member,day,'10:00',JSON.stringify([{serviceId:service,quantity:1}]),'']
    )).rows[0].id;
    assert.ok(original);
    const request='PHONE-'+crypto.randomUUID();
    const call=p=>h.db.query("select ("+s+".admin_create_phone_booking_request($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)).*",p);
    const input=args(request,day);
    await assert.rejects(call([...input.slice(0,9),false]),/BOOKING_OVERLAP_ACK_REQUIRED/);
    await assert.rejects(call([request,'U'+'9'.repeat(32),...input.slice(2)]),/ADMIN_REQUIRED/);
    const phone=(await call(input)).rows[0];
    assert.ok(phone.id);assert.equal(phone.member_id,null);assert.equal(phone.technician_id,null);
    assert.equal(phone.status,'confirmed');assert.equal(phone.confirmed_by,actor);
    assert.equal((await call(input)).rows[0].id,phone.id);
    await assert.rejects(call([...input.slice(0,6),'0999999999',...input.slice(7)]),/REQUEST_ID_CONFLICT/);
    assert.equal((await h.db.query("select count(*)::int n from "+s+".bookings where booking_date=$1 and start_time='10:00' and status in ('pending','confirmed')",[day])).rows[0].n,2);
    assert.equal((await h.db.query("select count(*)::int n from "+s+".booking_items where booking_id=$1",[phone.id])).rows[0].n,2);
    assert.equal((await h.db.query("select count(*)::int n from "+s+".booking_audit_events where target_id=$1::text and action='BOOKING_PHONE_CREATED'",[phone.id])).rows[0].n,1);
    await assert.rejects(h.db.query("select ("+s+".create_booking_bundle_request($1,$2,$3,$4,$5,$6)).id",[
      'BOOK-'+crypto.randomUUID(),member,day,'10:00',JSON.stringify([{serviceId:service,quantity:1}]),''
    ]),/BOOKING_SLOT_TAKEN/);
    const fresh=await h.approve('U'+'7'.repeat(32),'phone-fresh-'+crypto.randomUUID().slice(0,8));
    const type='(text,text,date,time without time zone,text,text,text,jsonb,text,boolean)';
    assert.ok((await h.db.query('select to_regprocedure($1) fn',[fresh.runtime_schema+'.admin_create_phone_booking_request'+type])).rows[0].fn);
    const rights=(await h.db.query("select has_function_privilege('anon',$1,'EXECUTE') a,has_function_privilege('service_role',$1,'EXECUTE') s",[s+'.admin_create_phone_booking_request'+type])).rows[0];
    assert.deepEqual(rights,{a:false,s:true});
  }finally{await h.db.close();}
});
