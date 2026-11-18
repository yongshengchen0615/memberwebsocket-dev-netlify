// Disposable PGlite comparison; no hosted URL or real member data is accepted.
const fs=require('node:fs'),path=require('node:path'),{performance}=require('node:perf_hooks'),{execFileSync}=require('node:child_process');
const fixture=require('../MemberWebsocket-dev/tests/integration/business-platform-fixture.cjs');
(async()=>{const h=await fixture();try{
 const owner='U'+'2'.repeat(32),t=await h.approve(owner,'frontdesk-benchmark'),s=t.runtime_schema;
 const dir=path.resolve(__dirname,'../MemberWebsocket-dev/supabase/migrations');
 await h.db.exec(fs.readFileSync(path.join(dir,'20261026050904_line_webhook.sql'),'utf8'));
 const q=async(sql,args=[])=>(await h.db.query(sql.replaceAll('S.',s+'.'),args)).rows;
 await q("update S.booking_settings set require_primary_technician=false,work_start_time='08:00',work_end_time='22:00'");
 const member=(await q("insert into S.members(line_user_id,member_code,invite_code,status,membership_status,is_test_account)values($1,'BENCH','ABCD123456','active','active',true)returning id",['U'+'3'.repeat(32)]))[0].id;
 await q('update S.members set is_test_account=false where id=$1',[member]);await q("insert into S.booking_service_types(name)values('BENCH')");
 const service=(await q("insert into S.booking_services(title,duration_minutes,price_amount,service_type,created_by)values('BENCH',30,100,'BENCH',$1)returning id",[owner]))[0].id;
 const measure=async label=>{const times=[],counts=[];for(let i=0;i<35;i++){const begin=performance.now();const b=(await q("select (S.create_group_booking_request_v2($1,$2,current_date+3,'10:00',$3,'')).id id",['B-'+crypto.randomUUID(),member,[{technicianId:null,items:[{serviceId:service,quantity:1}]}]]))[0].id;const elapsed=performance.now()-begin;const n=(await q('select count(*)::int n from S.notice_outbox where booking_id=$1',[b]))[0].n;await q('delete from S.bookings where id=$1',[b]);await q('truncate S.realtime_events,S.booking_audit_events,S.audit_logs');if(i>=5){times.push(elapsed);counts.push(n);}}times.sort((a,b)=>a-b);return{label,samples:times.length,p50ms:times[Math.floor(times.length*.5)],p95ms:times[Math.floor(times.length*.95)],outboxRowsPerBooking:[...new Set(counts)]};};
 const before=await measure('baseline template: no frontdesk projection');
 await h.db.exec(fs.readFileSync(path.join(dir,'20261118122150_frontdesk_booking_access.sql'),'utf8'));
 const after=await measure('candidate: frontdesk disabled/unconfigured');
 console.log(JSON.stringify({source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sqlSha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(dir,'20261118122150_frontdesk_booking_access.sql'))).digest('hex'),environment:'Node '+process.version+'; disposable PGlite; same database/fixture; 5 warmups + 30 measured creations per phase',before,after,note:'Local SQL contract comparison only; no claim about hosted network speed. No existing admin/member fanout increase is expected with frontdesk disabled.'},null,2));
}finally{await h.db.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
