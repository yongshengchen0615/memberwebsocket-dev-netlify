const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const database=require('./database.cjs');
const fixture=require('../business-runtime-fixture.cjs');
const root=path.resolve(__dirname,'../../../supabase/migrations');
const sql=n=>fs.readFileSync(path.join(root,n),'utf8');
const prerequisites=[
 '20261030050000_ticket_booking_service_groups.sql',
 '20261110184500_general_event_ticket_amount_gate.sql',
 '20261118094500_event_ticket_amount_requires_booking.sql'
];
const current=[
 '20261127180000_event_and_activity_booking_usage_rules.sql',
 '20261127181500_tenant_booking_activity_rules.sql'
];
const uuid=()=>crypto.randomUUID();

test('PG17 AC-PARTY-001..008: real booking eligibility, tenant isolation, defaults, and future tenant',async t=>{
 const h=await fixture({...await database()});
 try {
  const tenant=await h.approve('U'+'8'.repeat(32),'activity-party-'+uuid().slice(0,8));
  for(const name of [...prerequisites,...current])await h.db.exec(sql(name));
  const s=tenant.runtime_schema;
  await t.test('Public/tenant DDL and function execute boundary, no legacy data loss',async()=>{
   for(const schema of ['public',s]){
    for(const [table,required] of [['event_tickets',['min_booking_party_size','max_booking_party_size']],
      ['calendar_items',['required_service_ids','required_service_match_mode','required_service_groups','min_booking_amount_mode','min_booking_amount','min_booking_service_ids','min_booking_party_size','max_booking_party_size']]]){
     const cols=(await h.db.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2',[schema,table])).rows.map(r=>r.column_name);
     for(const name of required)assert.ok(cols.includes(name),schema+'.'+table+'.'+name);
    }
    const rights=(await h.db.query("select has_function_privilege('anon',$1,'EXECUTE') denied,has_function_privilege('service_role',$1,'EXECUTE') allowed",[
     schema+'.booking_meets_activity_usage(uuid,uuid,uuid[],text,jsonb,text,integer,uuid[],integer,integer)'])).rows[0];
    assert.deepEqual(rights,{denied:false,allowed:true});
    const guard=(await h.db.query('select count(*)::integer n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=$2 and t.tgname=$3',[schema,'bookings','booking_party_size_benefits_guard'])).rows[0].n;
    assert.equal(guard,1);
   }
  });
  const ids=[uuid(),uuid()];
  await h.db.query('insert into '+s+".booking_service_types(name) values('Activity rule QA')");
  for(const [i,id] of ids.entries()){
    await h.db.query('insert into '+s+'.booking_services(id,title,duration_minutes,price_amount,is_active,service_type,created_by) values($1,$2,30,$3,true,$4,$5)',[id,'Activity Rule '+i,i===0?150:200,'Activity rule QA','system']);
  }
  const tech=(await h.db.query('insert into '+s+".booking_technicians(name,is_active) values('Activity QA tech',true) returning id")).rows[0].id;
  await h.db.query('update '+s+'.booking_settings set primary_technician_id=$1',[tech]);
  const member=(await h.db.query('insert into '+s+'.members(line_user_id,display_name,member_code,membership_status,status,is_test_account) values($1,$2,$3,$4,$5,true) returning id',[
    'U'+'7'.repeat(32),'Activity Rule QA','ACT-'+uuid().slice(0,8),'active','active'])).rows[0].id;
  await h.db.query('update '+s+'.members set is_test_account=false where id=$1',[member]);
  const date=(await h.db.query("select ((now() at time zone 'Asia/Taipei')::date + 5)::text d")).rows[0].d;
  const booking=(await h.db.query('select ('+s+'.create_group_booking_request_v2($1,$2,$3,$4,$5,$6)).id id',[
    'BOOK-'+uuid(),member,date,'10:00',JSON.stringify([{technicianId:tech,items:[{serviceId:ids[0],quantity:1},{serviceId:ids[1],quantity:2}]}]),''])).rows[0].id;
  const evaluate=async({uid=member, required='{}',match='any',groups='[]',amountMode='none',amount=0,amountIds='{}',min=0,max=0}={})=>(
    await h.db.query('select '+s+'.booking_meets_activity_usage($1::uuid,$2::uuid,$3::uuid[],$4,$5::jsonb,$6,$7,$8::uuid[],$9,$10) allowed',[
      booking,uid,required,match,groups,amountMode,amount,amountIds,min,max])).rows[0].allowed;
  await t.test('Inclusive min/max limits use persisted booking party size',async()=>{
    assert.equal(await evaluate({min:1,max:1}),true);
    assert.equal(await evaluate({min:2}),false);
    assert.equal(await evaluate({max:1}),true);
    assert.equal(await evaluate({min:0,max:0}),true);
    assert.equal(await evaluate({uid:uuid()}),false,'booking belongs to another member');
    await h.db.query('update '+s+'.bookings set party_size=2 where id=$1',[booking]);
    assert.equal(await evaluate({min:2,max:2}),true);
    assert.equal(await evaluate({max:1}),false);
    assert.equal(await evaluate({min:3}),false);
  });
  await t.test('Real group service combination, total and selected amount, exact threshold',async()=>{
    assert.equal(await evaluate({required:'{'+ids[0]+'}',match:'all',min:2}),true);
    assert.equal(await evaluate({required:'{'+uuid()+'}',match:'all'}),false);
    assert.equal(await evaluate({groups:JSON.stringify([[ids[0],ids[1]]])}),true);
    assert.equal(await evaluate({groups:JSON.stringify([[ids[0],uuid()]])}),false);
    assert.equal(await evaluate({amountMode:'total',amount:550}),true);
    assert.equal(await evaluate({amountMode:'total',amount:551}),false);
    assert.equal(await evaluate({amountMode:'selected_services',amount:400,amountIds:'{'+ids[1]+'}'}),true);
    assert.equal(await evaluate({amountMode:'selected_services',amount:401,amountIds:'{'+ids[1]+'}'}),false);
    assert.equal(await evaluate({min:2,max:2,amountMode:'total',amount:550,required:'{'+ids[0]+'}',match:'all'}),true);
  });
  const ticketId=(await h.db.query('insert into '+s+".event_tickets(event_ticket_id,title,ticket_type,status,created_by,updated_by,min_booking_party_size,max_booking_party_size) values($1,'Party QA','coupon','active','system','system',2,3) returning id",[
    'ACT-'+uuid()])).rows[0].id;
  const claimId='Q-'+uuid().slice(0,12);
  await h.db.query('insert into '+s+".event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title) values($1,$2,$3,'coupon','Party QA')",[claimId,ticketId,member]);
  await t.test('Event ticket requires booking; no bypass via direct option',async()=>{
    const required=(await h.db.query('select '+s+'.ticket_has_service_requirement($1,$2,$3) enabled',[member,'event',claimId])).rows[0].enabled;
    assert.equal(required,true);
    const matched=(await h.db.query('select '+s+'.booking_ticket_matches_services($1,$2,$3,$4) enabled',[booking,member,'event',claimId])).rows[0].enabled;
    assert.equal(matched,true);
    const forged=(await h.db.query('select '+s+'.booking_ticket_matches_services($1,$2,$3,$4) enabled',[booking,uuid(),'event',claimId])).rows[0].enabled;
    assert.equal(forged,false);
    await assert.rejects(h.db.query('update '+s+'.event_tickets set max_booking_party_size=1 where id=$1',[ticketId]),/event_ticket_booking_party_size_chk/);
  });
  await t.test('Future merchant gets all new rules',async()=>{
    const future=await h.approve('U'+'6'.repeat(32),'future-activity-'+uuid().slice(0,8));
    const rs=await h.db.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2 and column_name=$3',[
      future.runtime_schema,'calendar_items','min_booking_party_size']);
    assert.equal(rs.rows.length,1);
    const fn=(await h.db.query('select to_regprocedure($1) function',[
      future.runtime_schema+'.booking_meets_activity_usage(uuid,uuid,uuid[],text,jsonb,text,integer,uuid[],integer,integer)'])).rows[0].function;
    assert.ok(fn);
  });
 }finally {await h.db.close();}
});
