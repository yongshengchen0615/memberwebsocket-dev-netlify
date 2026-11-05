const {test}=require('node:test');
const assert=require('node:assert/strict');
const fixture=require('./fixtures/booking-price-fixture.cjs');

test('AC-001..010: independent item prices, activation, quotes, history and tenant boundaries',async t=>{
 const h=await fixture();const {db,one,a,b,tenant:s,other,actor}=h;
 try{
  await t.test('upgrade keeps original prices and installs service-only RPC',async()=>{
   assert.ok((await one("select to_regprocedure($1) fn",[s+'.booking_price_resolve(uuid)'])).fn,'per-item price publishing RPC must be installed');
   assert.equal((await h.resolve(a)).priceAmount,500);
   assert.equal((await h.resolve(b)).priceAmount,900);
   assert.equal((await one(`select price_amount from ${s}.booking_services where id=$1`,[a])).price_amount,500);
  });
  await t.test('immediate price changes A only and keeps service IDs and old snapshots',async()=>{
   await db.query(`insert into ${s}.booking_items(service_id,unit_price_amount,service_title) values($1,500,'A')`,[a]);
   const p=await h.publish(a,700);
   assert.equal(p.priceAmount,700);
   assert.equal((await h.resolve(a)).priceAmount,700);
   assert.equal((await h.resolve(b)).priceAmount,900);
   assert.equal((await h.resolve(a,other)).priceAmount,500);
   assert.equal((await one(`select unit_price_amount from ${s}.booking_items`)).unit_price_amount,500);
  });
  await t.test('different future prices activate at each Taipei timestamp, including multiple prices for A',async()=>{
   await h.publish(a,800,'2035-11-10T09:00:00+08:00');
   await h.publish(b,1000,'2035-11-10T10:00:00+08:00');
   await h.publish(a,850,'2035-12-01T00:00:00+08:00');
   await h.clock('2035-11-10T00:59:59Z');assert.equal((await h.resolve(a)).priceAmount,700);
   await h.clock('2035-11-10T01:00:00Z');assert.equal((await h.resolve(a)).priceAmount,800);assert.equal((await h.resolve(b)).priceAmount,900);
   await h.clock('2035-11-10T02:00:00Z');assert.equal((await h.resolve(b)).priceAmount,1000);
   await h.clock('2035-11-30T16:00:00Z');assert.equal((await h.resolve(a)).priceAmount,850);
   await h.clock('');
  });
  await t.test('same item/time is unique; requests are idempotent and reject changed replay',async()=>{
   const req=crypto.randomUUID();const version=(await h.resolve(a)).priceVersion;
   const p=await h.publish(a,880,'2036-01-01T00:00:00+08:00',req,version);
   assert.deepEqual(await h.publish(a,880,'2036-01-01T00:00:00+08:00',req,version),p);
   await assert.rejects(h.publish(a,881,'2036-01-01T00:00:00+08:00'),/BOOKING_PRICE_TIME_CONFLICT/);
   await assert.rejects(h.publish(a,881,'2036-01-02T00:00:00+08:00',req,version),/BOOKING_PRICE_REQUEST_CONFLICT/);
   const id=crypto.randomUUID();await h.publish(a,710,null,id,version);
   await assert.rejects(h.publish(a,720,null,crypto.randomUUID(),version),/BOOKING_PRICE_CHANGED/);
  });
  await t.test('cancel future event cannot cancel already effective price and does not erase other schedules',async()=>{
   const p=await h.publish(b,1100,'2037-01-01T00:00:00+08:00');
   const c=(await one(`select ${s}.booking_price_cancel($1,$2,$3,$4) value`,[p.id,p.updatedAt,actor,crypto.randomUUID()])).value;
   assert.equal(c.status,'cancelled');
   await h.clock('2037-01-01T00:00:00Z');assert.equal((await h.resolve(b)).priceAmount,1000);await h.clock('');
   const live=await h.publish(b,950);
   await assert.rejects(one(`select ${s}.booking_price_cancel($1,$2,$3,$4)`,[live.id,live.updatedAt,actor,crypto.randomUUID()]),/BOOKING_PRICE_ALREADY_EFFECTIVE/);
  });
  await t.test('reschedule is atomic when the new timestamp conflicts',async()=>{
   const first=await h.publish(b,1200,'2038-01-01T00:00:00+08:00');
   await h.publish(b,1250,'2038-02-01T00:00:00+08:00');
   const version=(await h.resolve(b)).priceVersion;
   await assert.rejects(one(`select ${s}.booking_price_reschedule($1,$2,$3,$4,$5,$6,$7)`,[first.id,first.updatedAt,1300,'2038-02-01T00:00:00+08:00',crypto.randomUUID(),actor,version]),/BOOKING_PRICE_TIME_CONFLICT/);
   assert.equal((await one(`select cancelled_at from ${s}.booking_service_price_publications where id=$1`,[first.id])).cancelled_at,null);
   const result=(await one(`select ${s}.booking_price_reschedule($1,$2,$3,$4,$5,$6,$7) value`,[first.id,first.updatedAt,1300,'2038-03-01T00:00:00+08:00',crypto.randomUUID(),actor,version])).value;
   assert.equal(result.priceAmount,1300);
  });
  await t.test('stale individual quotes reject even when two price changes keep the same total',async()=>{
   const oldA=await h.resolve(a),oldB=await h.resolve(b);
   await h.publish(a,oldA.priceAmount+100);await h.publish(b,oldB.priceAmount-100);
   await h.quote([{serviceId:a,...oldA},{serviceId:b,...oldB}]);
   await assert.rejects(db.query(`insert into ${s}.booking_items(service_id,unit_price_amount) values($1,500)`,[a]),/BOOKING_PRICE_CHANGED/);
   const current=await h.resolve(a);await h.quote([{serviceId:a,...current}]);
   await db.query(`insert into ${s}.booking_items(service_id,unit_price_amount) values($1,500)`,[a]);
   await db.query(`insert into ${s}.booking_participant_items(service_id,unit_price_amount) values($1,500)`,[a]);
   assert.equal((await one(`select unit_price_amount from ${s}.booking_items order by unit_price_amount desc limit 1`)).unit_price_amount,current.priceAmount);
   assert.equal((await one(`select unit_price_amount from ${s}.booking_participant_items`)).unit_price_amount,current.priceAmount);
   await db.query("select set_config('request.headers','{}',false)");
  });
  await t.test('a preview Edge write without a confirmed quote cannot opt out of an effective price',async()=>{
   await db.query("select set_config('request.headers','{\"x-booking-price-preview\":\"1\",\"x-booking-price-check\":\"1\"}',false)");
   await assert.rejects(db.query(`insert into ${s}.booking_items(service_id,unit_price_amount) values($1,500)`,[a]),/BOOKING_PRICE_CHANGED/);
  });
  await t.test('a stale non-price edit cannot overwrite a newly effective price',async()=>{
   const old=await h.resolve(a);await h.publish(a,old.priceAmount+50);
   await h.quote([{serviceId:a,...old}]);
   await assert.rejects(db.query(`update ${s}.booking_services set title='stale',price_amount=$1 where id=$2`,[old.priceAmount,a]),/BOOKING_PRICE_CHANGED/);
   assert.equal((await one(`select title from ${s}.booking_services where id=$1`,[a])).title,'A');
   await db.query("select set_config('request.headers','{}',false)");
  });
  await t.test('invalid amount/time/service and cross-tenant actor cannot publish',async()=>{
   for(const price of [-1,10000001])await assert.rejects(h.publish(a,price),/INVALID_SERVICE_PRICE/);
   await assert.rejects(h.publish(a,10,'2000-01-01T00:00:00Z'),/INVALID_PRICE_PUBLISH_TIME/);
   await assert.rejects(h.publish(a,10,null,crypto.randomUUID(),null,other),/ADMIN_REQUIRED/);
   await assert.rejects(h.publish('00000000-0000-4000-8000-000000000010',10,null,crypto.randomUUID(),'x'),/BOOKING_SYSTEM_SERVICE_IMMUTABLE/);
  });
  await t.test('revocation cancels future events permanently while preserving an effective price',async()=>{
   const before=(await h.resolve(a)).priceAmount;
   const p=await h.publish(a,9999,'2040-01-01T00:00:00+08:00');
   await db.query("update platform_private.admin_qualifications set status='suspended',access_revoked_before=clock_timestamp() where applicant_line_user_id=$1",[actor]);
   assert.equal((await one(`select cancelled_at is not null cancelled from ${s}.booking_service_price_publications where id=$1`,[p.id])).cancelled,true);
   await db.query("update platform_private.admin_qualifications set status='approved' where applicant_line_user_id=$1",[actor]);
   await h.clock('2041-01-01T00:00:00Z');assert.notEqual((await h.resolve(a)).priceAmount,9999);await h.clock('');
   assert.equal((await h.resolve(a)).priceAmount,before);
  });
  await t.test('direct anonymous and authenticated table, view and RPC access is denied',async()=>{
   for(const role of ['anon','authenticated']){
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query(`select * from ${s}.booking_service_price_publications`),/permission denied/);
    await assert.rejects(db.query(`select ${s}.booking_price_resolve($1)`,[a]),/permission denied/);
    await db.exec('reset role');
   }
  });
 }finally{await db.close();}
});

test('AC-001/007: real existing group RPC and original snapshot triggers keep effective prices in both item tables',async()=>{
 const create=require('./business-runtime-fixture.cjs');const h=await create();
 const fs=require('node:fs'),path=require('node:path');
 const dir=path.resolve(__dirname,'../../supabase/migrations');
 const migration=fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(x=>x.endsWith('_booking_item_price_publishing.sql'))),'utf8');
 try{
  const actor='U'+'5'.repeat(32),tenant=await h.approve(actor,'price-real-core');const s=tenant.runtime_schema;
  await h.db.exec(migration);
  await h.db.exec(migration); // Idempotent upgrade must not replace the saved provisioning base.
  const wrapper=(await h.db.query("select pg_get_functiondef(oid) def from pg_proc where pronamespace=$1::regnamespace and proname='register_snapshot_receipt_v2'",[s])).rows[0];
  assert.match(wrapper.def,/PERFORM .*booking_price_context_time/,'transitive receipt wrapper must acquire price lock before member/receipt rows');
  await h.db.query(`insert into ${s}.booking_service_types(name) values('QA')`);
  const svc=(await h.db.query(`insert into ${s}.booking_services(title,duration_minutes,price_amount,service_type,created_by) values('QA price',30,500,'QA',$1) returning id`,[actor])).rows[0].id;
  const tech=(await h.db.query(`insert into ${s}.booking_technicians(name,is_active) values('QA',true) returning id`)).rows[0].id;
  await h.db.query(`update ${s}.booking_settings set primary_technician_id=$1`,[tech]);
  const member=(await h.db.query(`insert into ${s}.members(line_user_id,display_name,member_code,membership_status,status,is_test_account) values($1,'QA','PRICE-QA','active','active',true) returning id`,['U'+'7'.repeat(32)])).rows[0].id;
  await h.db.query(`update ${s}.members set is_test_account=false where id=$1`,[member]);
  const version=(await h.db.query(`select ${s}.booking_price_resolve($1) p`,[svc])).rows[0].p.priceVersion;
  const published=(await h.db.query(`select ${s}.booking_price_publish($1,800,null,'core-publish',$2,$3) p`,[svc,actor,version])).rows[0].p;
  await h.db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'x-booking-price-preview':'1','x-booking-price-check':'1','x-booking-price-quote':JSON.stringify([{serviceId:svc,priceAmount:800,priceVersion:published.id}])})]);
  const booking=(await h.db.query(`select (${s}.create_group_booking_request_v2($1,$2,(now() at time zone 'Asia/Taipei')::date+5,'10:00',$3,'')).id id`,['core-booking',member,JSON.stringify([{technicianId:tech,items:[{serviceId:svc,quantity:1}]}])])).rows[0].id;
  assert.equal((await h.db.query(`select unit_price_amount from ${s}.booking_items where booking_id=$1 and service_id=$2`,[booking,svc])).rows[0].unit_price_amount,800);
  assert.equal((await h.db.query(`select i.unit_price_amount from ${s}.booking_participant_items i join ${s}.booking_participants p on p.id=i.participant_id where p.booking_id=$1 and i.service_id=$2`,[booking,svc])).rows[0].unit_price_amount,800);
  await h.db.query("select set_config('request.headers','{}',false)");
  const fresh=await h.approve('U'+'8'.repeat(32),'price-fresh-core');
  assert.ok((await h.db.query('select to_regclass($1) t',[fresh.runtime_schema+'.booking_services_priced'])).rows[0].t);
 }finally{await h.db.close();}
});


test('review regressions: preview price edits, legacy isolation, admin revocation and replay identity',async t=>{
 const h=await fixture();const {db,one,a,b,tenant:s,actor}=h;
 try{
  await h.publish(a,700);
  await t.test('legacy snapshot remains on the unchanged base price',async()=>{
   await db.query(`insert into ${s}.booking_items(service_id,unit_price_amount) values($1,500)`,[a]);
   assert.equal((await one(`select unit_price_amount from ${s}.booking_items`)).unit_price_amount,500);
  });
  await t.test('preview non-price edit does not write preview effective price into main base',async()=>{
   await h.quote([{serviceId:a,...await h.resolve(a)}]);
   await db.query(`update ${s}.booking_services set title='renamed',price_amount=700 where id=$1`,[a]);
   assert.equal((await one(`select price_amount from ${s}.booking_services where id=$1`,[a])).price_amount,500);
   assert.equal((await h.resolve(a)).priceAmount,700);
  });
  await t.test('preview ordinary edit cannot silently change a price; price editor is required',async()=>{
   await h.quote([{serviceId:a,...await h.resolve(a)}]);
   await assert.rejects(db.query(`update ${s}.booking_services set price_amount=500 where id=$1`,[a]),/BOOKING_PRICE_USE_PUBLISHING/);
   await db.query("select set_config('request.headers','{}',false)");
  });
  await t.test('reschedule replay is bound to its original source event',async()=>{
   const first=await h.publish(b,800,'2040-01-01T00:00:00+08:00');
   const second=await h.publish(b,900,'2040-02-01T00:00:00+08:00');
   const v=(await h.resolve(b)).priceVersion,req=crypto.randomUUID();
   const args=[first.id,first.updatedAt,950,'2040-03-01T00:00:00+08:00',req,actor,v];
   const sql=`select ${s}.booking_price_reschedule($1,$2,$3,$4,$5,$6,$7) value`;
   const result=(await one(sql,args)).value;
   assert.deepEqual((await one(sql,args)).value,result);
   await assert.rejects(one(sql,[second.id,second.updatedAt,...args.slice(2)]),/BOOKING_PRICE_REQUEST_CONFLICT/);
   assert.equal((await one(`select cancelled_at from ${s}.booking_service_price_publications where id=$1`,[second.id])).cancelled_at,null);
  });
  await t.test('role downgrade and actor identity change cancel future prices',async()=>{
   for(const field of ['role','line_user_id']){
    const p=await h.publish(a,8888,'2044-01-01T00:00:00+08:00');
    if(field==='role')await db.query(`update ${s}.admins set role='none' where line_user_id=$1`,[actor]);
    else await db.query(`update ${s}.admins set line_user_id=$2 where line_user_id=$1`,[actor,'U'+'9'.repeat(32)]);
    assert.equal((await one(`select cancelled_at is not null cancelled from ${s}.booking_service_price_publications where id=$1`,[p.id])).cancelled,true);
    if(field==='role')await db.query(`update ${s}.admins set role='admin' where line_user_id=$1`,[actor]);
    else await db.query(`update ${s}.admins set line_user_id=$1 where line_user_id=$2`,[actor,'U'+'9'.repeat(32)]);
   }
  });
  await t.test('deleting a tenant cancels events in its retained runtime schema',async()=>{
   const p=await h.publish(b,9999,'2046-01-01T00:00:00+08:00');
   await db.query('delete from platform_private.tenants where runtime_schema=$1',[s]);
   assert.equal((await one(`select cancelled_at is not null cancelled from ${s}.booking_service_price_publications where id=$1`,[p.id])).cancelled,true);
   await db.query("insert into platform_private.tenants(id,runtime_schema,owner_line_user_id) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,$2)",[s,actor]);
  });
  await t.test('runtime admin suspension cancels future prices and reactivation does not restore them',async()=>{
   const p=await h.publish(a,9999,'2042-01-01T00:00:00+08:00');
   await db.query(`update ${s}.admins set status='suspended' where line_user_id=$1`,[actor]);
   assert.equal((await one(`select cancelled_at is not null cancelled from ${s}.booking_service_price_publications where id=$1`,[p.id])).cancelled,true);
   await db.query(`update ${s}.admins set status='active' where line_user_id=$1`,[actor]);
   await h.clock('2043-01-01T00:00:00Z');assert.equal((await h.resolve(a)).priceAmount,700);await h.clock('');
  });
 }finally{await db.close();}
});
