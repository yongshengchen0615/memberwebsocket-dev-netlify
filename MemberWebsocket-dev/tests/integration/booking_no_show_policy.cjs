const {test}=require('node:test'),assert=require('node:assert/strict');
const setup=require('./fixtures/booking-event-setup.cjs');
const owner='U'+'2'.repeat(32),memberLine='U'+'3'.repeat(32);
test('AC-173: disabled-by-default policy, atomic no-show counting, restriction, legacy-appeal denial, revoke and expiry',async()=>{
 const h=await setup();try{
  const risk=async(action,body={},actor=owner)=>(await h.q('select S.admin_booking_no_show($1,$2,$3) result',[actor,action,body]))[0].result;
  let data=await risk('get');assert.equal(data.policy.enabled,false);assert.equal(data.policy.threshold_count,null);assert.equal(Object.hasOwn(data.policy,'appeal_enabled'),false);
  await assert.rejects(risk('save',{version:1,enabled:true}),/check constraint/);
  await risk('save',{version:1,enabled:true,threshold_count:2,lookback_days:90,duration_count:1,duration_unit:'months',grace_minutes:0,appeal_enabled:true,contact_text:'請電話聯絡店家'});
  const mark=async()=>{
   const b=await h.make();
   await h.q('alter table S.bookings disable trigger booking_enforce_advance_window');await h.q('alter table S.bookings disable trigger bookings_zz_enforce_live_clock');
   await h.q('update S.bookings set booking_date=current_date-1 where id=$1',[b]);
   await h.q('alter table S.bookings enable trigger booking_enforce_advance_window');await h.q('alter table S.bookings enable trigger bookings_zz_enforce_live_clock');
   const version=(await h.state(b)).updated_at;
   await Promise.all([h.q('select S.admin_mark_booking_no_show($1,$2,$3,$4)',[owner,b,version,'合成資料']),h.q('select S.admin_mark_booking_no_show($1,$2,$3,$4)',[owner,b,version,'合成資料'])]);
   return b;
  };
  const first=await mark();assert.equal((await h.q('select S.booking_no_show_status($1) result',[memberLine]))[0].result.restricted,false);
  const second=await mark();
  assert.equal((await h.q('select count(*)::int n from S.booking_no_show_events'))[0].n,2);
  let status=(await h.q('select S.booking_no_show_status($1) result',[memberLine]))[0].result;assert.equal(status.restricted,true);
  await assert.rejects(h.make(),/BOOKING_RESTRICTED/);
  assert.equal((await h.q('select count(*)::int n from S.bookings'))[0].n,2,'blocked create transaction leaves no extra bookings');
  await assert.rejects(h.q('select S.booking_no_show_appeal($1,$2)',[memberLine,'舊入口應拒絕']),/does not exist/);
  assert.equal((await h.q('select count(*)::int n from S.booking_restriction_appeals'))[0].n,0);
  assert.equal(Object.hasOwn(status,'appealEnabled'),false);
  await assert.rejects(risk('resolve',{appealId:crypto.randomUUID(),reason:'舊操作'}),/INVALID_INPUT/);
  const end=(await h.q('select ends_at from S.booking_restrictions'))[0].ends_at;
  assert.equal((await h.q('select S.booking_active_restriction($1,$2) result',[h.m,end]))[0].result,null,'at exact deadline access is restored without a cron');
  await assert.rejects(risk('revoke',{bookingId:first,reason:'假冒'},memberLine),/ADMIN_REQUIRED/);
  await risk('revoke',{bookingId:first,reason:'人工查核為誤判'});await risk('revoke',{bookingId:first,reason:'重試'});
  assert.equal((await h.q('select S.booking_no_show_status($1) result',[memberLine]))[0].result.restricted,false);
  assert.equal((await h.state(first)).status,'no_show','original booking history is retained');
  assert.equal((await h.q("select count(*)::int n from S.booking_audit_events where action='BOOKING_RISK_REVOKE'"))[0].n,1);
  const existing=(await risk('get')).policy;
  await assert.rejects(risk('save',{...existing,version:1}),/BOOKING_CONFLICT/);
  for(const role of ['anon','authenticated']){
   await h.db.exec('set role '+role);
   await assert.rejects(h.q('select * from S.booking_restrictions'),/permission denied/);
   await assert.rejects(h.q('select S.admin_booking_no_show($1,$2,$3)',[owner,'get',{}]),/permission denied/);
   await h.db.exec('reset role');
  }
  assert.ok(second);
 }finally{await h.db.close();}
});
