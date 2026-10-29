const assert=require('node:assert/strict');

async function helpers(h){
 const risk=async(action,body={},actor=h.owner)=>(await h.q('select S.admin_booking_no_show($1,$2,$3) result',[actor,action,body]))[0].result;
 const save=async(body)=>{const {policy}=await risk('get');return risk('save',{...policy,...body,version:policy.version});};
 const enable=()=>save({enabled:true,threshold_count:2,lookback_days:30,duration_count:1,duration_unit:'months',grace_minutes:0,contact_text:'Synthetic contact'});
 const past=async(b,days=1,recent=false)=>{
  // Synthetic history only. Live-clock and advance-window guards still apply
  // to every production API and to subsequent creation attempts in these tests.
  await h.q('alter table S.bookings disable trigger booking_enforce_advance_window');
  await h.q('alter table S.bookings disable trigger bookings_zz_enforce_live_clock');
  try{
   if(recent)await h.q("with t as(select date_trunc('hour',clock_timestamp() at time zone 'Asia/Taipei')-interval '2 hours' ts) update S.bookings set booking_date=t.ts::date,start_time=t.ts::time,end_time=(t.ts+make_interval(mins=>total_duration_minutes))::time from t where id=$1",[b]);
   else await h.q('update S.bookings set booking_date=current_date-$2::int where id=$1',[b,days]);
  }finally{
   await h.q('alter table S.bookings enable trigger booking_enforce_advance_window');
   await h.q('alter table S.bookings enable trigger bookings_zz_enforce_live_clock');
  }
  return b;
 };
 const mark=async(b)=>(await h.q('select S.admin_mark_booking_no_show($1,$2,$3,$4) result',[h.owner,b,(await h.state(b)).updated_at,'Synthetic no-show']))[0].result;
 const status=async(actor=h.memberLine)=>(await h.q('select S.booking_no_show_status($1) result',[actor]))[0].result;
 return{risk,save,enable,past,mark,status};
}

function register(test,setup,label='PostgreSQL snapshot'){
 test(`${label}: context migration upgrades existing records without changing policy snapshots or audit history`,async()=>{
  const h=await setup({beforeRiskContext:true});try{
   const x=await helpers(h);await x.enable();await x.save({threshold_count:1});
   const b=await x.past(await h.make());await x.mark(b);
   await h.q('select S.booking_no_show_appeal($1,$2)',[h.memberLine,'Synthetic upgrade review']);
   const before=await x.risk('get');assert.equal(before.restrictions[0].member_code,undefined);
   const audits=await h.q('select count(*)::int n from S.booking_audit_events');
   const fs=require('node:fs'),path=require('node:path');
   await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations/20261025125207_booking_risk_record_context.sql'),'utf8'));
   const after=await x.risk('get');assert.deepEqual(after.policy,before.policy);assert.equal(after.restrictions[0].member_code,'QA-NOTIFY');assert.equal(after.appeals[0].source_booking_id,b);
   assert.deepEqual(after.restrictions[0].policy_snapshot,before.restrictions[0].policy_snapshot);assert.equal(String(after.restrictions[0].ends_at),String(before.restrictions[0].ends_at));
   assert.deepEqual(await h.q('select count(*)::int n from S.booking_audit_events'),audits);
   for(const role of ['anon','authenticated']){await h.db.exec('set role '+role);try{await assert.rejects(h.q('select S.admin_booking_no_show($1,\'get\')',[h.owner]),/permission denied/);}finally{await h.db.exec('reset role');}}
  }finally{await h.db.close();}
 });
 test(`${label}: risk records preserve member and source booking context without adding contact or LINE identity`,async()=>{
  const h=await setup();try{
   const x=await helpers(h);await x.enable();await x.save({threshold_count:1});
   const b=await x.past(await h.make());await x.mark(b);
   const before=await x.risk('get'),r=before.restrictions[0];
   assert.equal(r.member_code,'QA-NOTIFY');assert.equal(r.source_booking_id,b);assert.equal(before.events[0].booking_id,b);
   assert.equal(Object.hasOwn(before,'appeals'),false,'retired archive must not be in the response');
   for(const key of ['line_user_id','phone','email','display_name'])assert.equal(Object.hasOwn(r,key),false);
   await assert.rejects(x.risk('resolve',{appealId:crypto.randomUUID(),reason:'Old action'}),/INVALID_INPUT/);
   const after=await x.risk('get');assert.deepEqual(after.restrictions[0].policy_snapshot,r.policy_snapshot);
   assert.equal(String(after.restrictions[0].ends_at),String(r.ends_at));assert.equal((await x.status()).restricted,true);
  }finally{await h.db.close();}
 });
 test(`${label}: outside-window, cancelled and revoked events never reach the active threshold`,async()=>{
  const h=await setup();try{
   const x=await helpers(h);await x.enable();
   const old=await x.past(await h.make(),45);await x.mark(old);
   const cancelled=await h.make();await h.q("update S.bookings set status='cancelled',cancelled_by=$2 where id=$1",[cancelled,h.owner]);
   assert.equal((await h.q('select count(*)::int n from S.booking_no_show_events'))[0].n,1);
   const first=await x.past(await h.make());await x.mark(first);assert.equal((await x.status()).restricted,false);
   const second=await x.past(await h.make());await x.mark(second);assert.equal((await x.status()).restricted,true);
   await x.risk('revoke',{bookingId:first,reason:'Synthetic correction'});
   assert.equal((await x.status()).restricted,false);
   await h.make();
   const end=(await h.q('select ends_at from S.booking_restrictions'))[0].ends_at;
   assert.equal((await h.q('select S.booking_active_restriction($1,$2) r',[h.m,end]))[0].r,null);
  }finally{await h.db.close();}
 });
 test(`${label}: historical and disabled-period events are not retroactive penalties`,async()=>{
  const h=await setup();try{
   const x=await helpers(h),historic=await x.past(await h.make());await x.mark(historic);
   await x.enable();
   const first=await x.past(await h.make());await x.mark(first);assert.equal((await x.status()).restricted,false);
   await x.save({enabled:false});const disabled=await x.past(await h.make());await x.mark(disabled);
   await x.save({enabled:true});const second=await x.past(await h.make());await x.mark(second);assert.equal((await x.status()).restricted,false);
   const third=await x.past(await h.make());await x.mark(third);assert.equal((await x.status()).restricted,true);
   assert.equal((await h.q('select count(*)::int n from S.booking_no_show_events'))[0].n,5);
  }finally{await h.db.close();}
 });
 test(`${label}: grace rejection rolls back status, risk event, audit and outbox`,async()=>{
  const h=await setup();try{
   const x=await helpers(h);await x.enable();await x.save({grace_minutes:180});
   const b=await x.past(await h.make(),1,true),before=await h.state(b);
   const counts=()=>h.q('select (select count(*)::int from S.booking_audit_events) audits,(select count(*)::int from S.notice_outbox) notices');
   const original=await counts();await assert.rejects(x.mark(b),/BOOKING_NO_SHOW_TOO_EARLY/);
   assert.equal((await h.state(b)).status,before.status);assert.equal(String((await h.state(b)).updated_at),String(before.updated_at));
   assert.deepEqual(await counts(),original);assert.equal((await h.q('select count(*)::int n from S.booking_no_show_events'))[0].n,0);
   await x.save({grace_minutes:0});await x.mark(b);
   assert.equal((await h.q('select e.occurred_at=(b.end_at at time zone \'Asia/Taipei\') correct from S.booking_no_show_events e join S.bookings b on b.id=e.booking_id'))[0].correct,true);
  }finally{await h.db.close();}
 });
 test(`${label}: duration snapshots survive policy changes; exact UTC and month-end expiry restore access`,async()=>{
  const h=await setup();try{
   const x=await helpers(h);await x.enable();await x.save({threshold_count:1});
   const b=await x.past(await h.make());await x.mark(b);
   const r=(await h.q('select * from S.booking_restrictions'))[0];
   assert.equal((await h.q("select ends_at=starts_at+interval '1 month' correct from S.booking_restrictions"))[0].correct,true);
   await x.save({duration_count:3,duration_unit:'weeks'});
   const after=(await h.q('select * from S.booking_restrictions'))[0];assert.equal(String(after.ends_at),String(r.ends_at));assert.deepEqual(after.policy_snapshot,r.policy_snapshot);
   await x.save({enabled:false});assert.equal((await x.status()).restricted,false);
   await x.save({enabled:true});assert.equal((await x.status()).restricted,true);
   // Synthetic absolute boundary spanning Jan 31 -> Feb 28, independent of the
   // machine's date and the SQL connection's presentation timezone.
   await h.q("update S.booking_restrictions set starts_at='2027-01-31 12:00:00+08',ends_at='2027-01-31 12:00:00+08'::timestamptz+interval '1 month'");
   for(const zone of ['UTC','Asia/Taipei','America/Los_Angeles']){
    await h.db.exec("set time zone '"+zone+"'");
    const boundary=(await h.q("select S.booking_active_restriction($1,'2027-02-28 03:59:59.999Z') before,S.booking_active_restriction($1,'2027-02-28 04:00:00Z') at_end,S.booking_active_restriction($1,'2027-02-28 04:00:00.001Z') after",[h.m]))[0];
    assert.equal(boundary.before.restricted,true);assert.equal(boundary.at_end,null);assert.equal(boundary.after,null);
   }
  }finally{await h.db.close();}
 });
 test(`${label}: foreign actors, foreign IDs and public roles cannot read or mutate risk data`,async()=>{
  const h=await setup();try{
   const x=await helpers(h);await x.enable();await x.save({threshold_count:1});
   const b=await x.past(await h.make());await x.mark(b);
   const otherOwner='U'+'4'.repeat(32),other=await h.approve(otherOwner,'risk-isolation'),s=other.runtime_schema;
   await h.db.query(`insert into ${s}.members(line_user_id,member_code,invite_code,status,membership_status,is_test_account)values($1,'SAME-MEMBER','ABCD654321','active','active',true)`,[h.memberLine]);
   assert.equal((await h.db.query(`select ${s}.booking_no_show_status($1) r`,[h.memberLine])).rows[0].r.restricted,false);
   await assert.rejects(x.risk('get',{},otherOwner),/ADMIN_REQUIRED/);
   await assert.rejects(x.risk('save',{version:2,enabled:false},h.memberLine),/ADMIN_REQUIRED/);
   await assert.rejects(h.db.query(`select ${s}.admin_booking_no_show($1,'revoke',$2)`,[otherOwner,{bookingId:b,reason:'Foreign booking'}]),/BOOKING_NOT_FOUND/);
   await h.q("update S.admins set status='disabled' where line_user_id=$1",[h.owner]);
   await assert.rejects(x.risk('release',{restrictionId:(await x.status()).restrictionId,reason:'Suspended admin'}),/ADMIN_REQUIRED/);
   for(const role of ['anon','authenticated']){
    await h.db.exec('set role '+role);
    try{
     await assert.rejects(h.q('select S.booking_no_show_status($1)',[h.memberLine]),/permission denied/);
     await assert.rejects(h.q('update S.booking_no_show_policy set enabled=false'),/permission denied/);
    }finally{await h.db.exec('reset role');}
   }
   assert.equal((await x.status()).restricted,true);
  }finally{await h.db.close();}
 });
 test(`${label}: appeals and release are idempotent, require reasons and preserve audit/history`,async()=>{
  const h=await setup();try{
   const x=await helpers(h);await x.enable();await x.save({threshold_count:1});
   const b=await x.past(await h.make());await x.mark(b);const r=await x.status();
   await assert.rejects(x.risk('release',{restrictionId:r.restrictionId,reason:' '}),/INVALID_APPEAL_REASON/);
   await assert.rejects(h.q('select S.booking_no_show_appeal($1,$2)',[h.memberLine,' ']),/INVALID_APPEAL_REASON/);
   await x.save({appeal_enabled:false});await assert.rejects(h.q('select S.booking_no_show_appeal($1,$2)',[h.memberLine,'Reason']),/BOOKING_APPEAL_UNAVAILABLE/);
   await x.save({appeal_enabled:true});await h.q('select S.booking_no_show_appeal($1,$2)',[h.memberLine,'Please review']);await h.q('select S.booking_no_show_appeal($1,$2)',[h.memberLine,'Replay']);
   const appeal=(await h.q('select * from S.booking_restriction_appeals'))[0];assert.equal(appeal.reason,'Please review');
   await x.risk('resolve',{appealId:appeal.id,reason:'Reviewed'});await x.risk('resolve',{appealId:appeal.id,reason:'Replay'});
   assert.equal((await x.status()).restricted,true,'review alone does not silently change the decision');
   await x.risk('release',{restrictionId:r.restrictionId,reason:'Approved exception'});await x.risk('release',{restrictionId:r.restrictionId,reason:'Replay'});
   assert.equal((await x.status()).restricted,false);assert.equal((await h.state(b)).status,'no_show');
   assert.equal((await h.q("select count(*)::int n from S.booking_audit_events where action='BOOKING_RISK_RELEASE'"))[0].n,1);
   assert.equal((await h.q("select count(*)::int n from S.booking_audit_events where action='BOOKING_RISK_RESOLVE'"))[0].n,1);
   assert.equal((await h.q('select revoked_at from S.booking_no_show_events'))[0].revoked_at,null);
   await h.make();
  }finally{await h.db.close();}
 });
}
module.exports={register,helpers};
