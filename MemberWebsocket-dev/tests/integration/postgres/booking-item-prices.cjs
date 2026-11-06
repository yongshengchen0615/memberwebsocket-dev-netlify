const {test}=require('node:test');const assert=require('node:assert/strict');
const database=require('./database.cjs');const fixture=require('../fixtures/booking-price-fixture.cjs');
test('AC-005/010: PostgreSQL physical sessions serialize price publication and enforce unique future time',async()=>{
 const h=await fixture({...await database()});const c1=await h.db.connect(),c2=await h.db.connect();
 try{
  const v=(await h.resolve(h.a)).priceVersion;
  const sql=`select ${h.tenant}.booking_price_publish($1,$2,$3,$4,$5,$6) value`;
  await c1.query('begin');
  await c1.query(sql,[h.a,700,null,'price-race-one',h.actor,v]);
  const second=c2.query(sql,[h.a,800,null,'price-race-two',h.actor,v]);
  const failed=assert.rejects(second,/BOOKING_PRICE_CHANGED/);
  await c1.query('commit');await failed;
  assert.equal((await h.resolve(h.a)).priceAmount,700);
  assert.equal((await h.one(`select count(*)::int n from ${h.tenant}.booking_service_price_publications`)).n,1);
  const current=await h.resolve(h.a);
  const headers=JSON.stringify({'x-booking-price-preview':'1','x-booking-price-check':'1','x-booking-price-quote':JSON.stringify([{serviceId:h.a,...current}])});
  await c1.query("select set_config('request.headers',$1,false)",[headers]);
  await c2.query("select set_config('request.headers',$1,false)",[headers]);
  await c1.query('begin');
  await c1.query(`select ${h.tenant}.create_price_fixture_booking($1)`,[h.a]);
  const edit=c2.query(`update ${h.tenant}.booking_services set title='renamed',price_amount=700 where id=$1`,[h.a]);
  await c1.query('commit');await edit;
  assert.equal((await h.one(`select unit_price_amount from ${h.tenant}.booking_items`)).unit_price_amount,700);
  assert.equal((await h.resolve(h.a)).priceAmount,700);
  await c1.query("select set_config('request.headers','{}',false)");await c2.query("select set_config('request.headers','{}',false)");
  const next=(await h.resolve(h.a)).priceVersion;
  await c1.query('begin');
  await c1.query(sql,[h.a,900,'2040-01-01T00:00:00+08:00','future-race-one',h.actor,next]);
  const duplicate=assert.rejects(c2.query(sql,[h.a,1000,'2040-01-01T00:00:00+08:00','future-race-two',h.actor,next]),/BOOKING_PRICE_TIME_CONFLICT/);
  await c1.query('commit');await duplicate;
  assert.equal((await h.one(`select count(*)::int n from ${h.tenant}.booking_service_price_publications where publish_mode='scheduled'`)).n,1);
  const restored=await h.db.backupRestore();
  assert.equal((await restored.client.query(`select count(*)::int n from ${h.tenant}.booking_service_price_publications`)).rows[0].n,2);
 }finally{await h.db.close();}
});


test('AC-010: nested receipt wrapper and group member lock use one consistent physical lock order',async()=>{
 const h=await fixture({...await database()});const c1=await h.db.connect(),c2=await h.db.connect(),barrier=await h.db.connect();
 try{
  for(const c of [c1,c2,barrier])await c.query("set statement_timeout='8s'");
  await barrier.query('select pg_advisory_lock(778899)');
  const pid=(await c1.query('select pg_backend_pid() pid')).rows[0].pid;
  const receipt=c1.query(`select ${h.tenant}.fixture_receipt_wrapper($1)`,[h.a]);
  let waiting=false;const deadline=Date.now()+4000;
  while(Date.now()<deadline){
   waiting=(await barrier.query("select wait_event='advisory' waiting from pg_stat_activity where pid=$1",[pid])).rows[0]?.waiting;
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(waiting,true,'receipt transaction reached the controlled barrier');
  const group=c2.query(`select ${h.tenant}.fixture_group_lock($1)`,[h.a]);
  await barrier.query('select pg_advisory_unlock(778899)');
  await Promise.all([receipt,group]);
  assert.equal((await h.one(`select count(*)::int n from ${h.tenant}.booking_items`)).n,1);
 }finally{await barrier.query('select pg_advisory_unlock_all()');await h.db.close();}
});


test('AC-008/010: real PostgREST pre-request and qualification revocation cannot invert locks',async()=>{
 const h=await fixture({...await database(),runtimePreRequest:true});const first=await h.db.connect(),second=await h.db.connect();
 try{
  const current=await h.resolve(h.a);
  const headers=JSON.stringify({'content-profile':h.tenant,'x-platform-admin-actor':h.actor,'x-platform-admin-tenant':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','x-platform-admin-issued-at':new Date().toISOString()});
  await first.query('begin');await first.query('set local role service_role');await first.query("select set_config('request.headers',$1,true)",[headers]);
  await first.query('select public.platform_business_pre_request()');
  const pid=(await second.query('select pg_backend_pid() pid')).rows[0].pid;
  const revoke=second.query("update platform_private.admin_qualifications set status='suspended' where applicant_line_user_id=$1",[h.actor]);revoke.catch(()=>{});
  let blocked=false;const deadline=Date.now()+4000;
  while(Date.now()<deadline){blocked=(await h.one("select wait_event_type='Lock' blocked from pg_stat_activity where pid=$1",[pid]))?.blocked;if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(blocked,true);
  const published=(await first.query(`select ${h.tenant}.booking_price_publish($1,950,'2045-01-01T00:00:00+08:00','prehook-race',$2,$3) p`,[h.a,h.actor,current.priceVersion])).rows[0].p;
  await first.query('commit');await revoke;
  assert.equal((await h.one(`select cancelled_at is not null cancelled from ${h.tenant}.booking_service_price_publications where id=$1`,[published.id])).cancelled,true);
 }finally{await h.db.close();}
});
