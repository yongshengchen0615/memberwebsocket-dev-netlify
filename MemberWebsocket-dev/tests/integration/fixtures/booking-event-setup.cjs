const fixture=require('../business-runtime-fixture.cjs');
const owner='U'+'2'.repeat(32),memberLine='U'+'3'.repeat(32);
module.exports=async(options={})=>{
 const h=await fixture(options),t=await h.approve(owner,'notification-events'),s=t.runtime_schema;
 const q=async(sql,args=[])=>(await h.db.query(sql.replaceAll('S.',s+'.'),args)).rows;
 await q("update S.booking_settings set require_primary_technician=false,primary_technician_id=null,work_start_time='08:00',work_end_time='22:00'");
 const m=(await q("insert into S.members(line_user_id,member_code,invite_code,status,membership_status,is_test_account)values($1,'QA-NOTIFY','ABCD123456','active','active',true)returning id",[memberLine]))[0].id;
 // All rows are synthetic and isolated. Lift only the test-member notification guard.
 await q('update S.members set is_test_account=false where id=$1',[m]);
 await q("insert into S.booking_service_types(name)values('QA')");
 const svc=(await q("insert into S.booking_services(title,duration_minutes,price_amount,service_type,created_by)values('QA service',30,100,'QA',$1)returning id",[owner]))[0].id;
 const tech=(await q("insert into S.booking_technicians(name,created_by)values('QA technician',$1)returning id",[owner]))[0].id;
 const make=async()=> (await q("select (S.create_group_booking_request_v2($1,$2,current_date+3,'10:00',$3,'')).id id",['BOOK-'+crypto.randomUUID(),m,[{technicianId:null,items:[{serviceId:svc,quantity:1}]}]]))[0].id;
 const state=async b=>(await q('select * from S.bookings where id=$1',[b]))[0];
 return{...h,q,s,t,m,svc,tech,make,state,owner,memberLine};
};
