const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const runtime=require('../business-runtime-fixture.cjs');
module.exports=async(options={})=>{
 const h=await runtime(options),dir=path.resolve(__dirname,'../../../supabase/migrations');
 const apply=name=>h.db.exec(fs.readFileSync(path.join(dir,name),'utf8'));
 try{
  const old=await h.approve('U'+'7'.repeat(32),'contract-existing');
  const repair=fs.readdirSync(dir).find(n=>n.endsWith('_repair_business_provisioning_contract.sql'));
  for(const name of ['20261030050000_ticket_booking_service_groups.sql',
    '20261109215000_booking_completion_calendar_bonus.sql',repair].filter(Boolean).sort())await apply(name);
  const fresh=await h.approve('U'+'8'.repeat(32),'contract-new');
  const expected=['booking_completion_settlements.calendar_bonus_details','event_tickets.required_service_groups','point_card_rewards.required_service_groups'];
  const actual=(await h.db.query("select table_name||'.'||column_name as name from information_schema.columns where table_schema=$1 and column_name in ('calendar_bonus_details','required_service_groups') order by name",[fresh.runtime_schema])).rows.map(x=>x.name);
  assert.deepEqual(actual,expected,'new merchant must receive the canonical ticket and bonus data contract');
  if(repair){await apply(repair);await apply(repair);}
  for(const tenant of [old,fresh]){
   const s=tenant.runtime_schema;
   assert.equal((await h.db.query(`select ${s}.booking_meets_required_services($1::uuid,'{}'::uuid[],'any','[]'::jsonb) allowed`,[crypto.randomUUID()])).rows[0].allowed,true);
   assert.equal((await h.db.query(`select ${s}.booking_meets_required_services($1::uuid,'{}'::uuid[],'any',$2::jsonb) allowed`,[crypto.randomUUID(),JSON.stringify([[crypto.randomUUID()]])])).rows[0].allowed,false);
   assert.equal((await h.db.query(`select ${s}.ticket_service_groups_valid('[[]]'::jsonb) valid`)).rows[0].valid,false);
   assert.equal((await h.db.query(`select ${s}.ticket_service_groups_valid('[]'::jsonb) valid`)).rows[0].valid,true);
   assert.equal((await h.db.query("select count(*)::int n from pg_trigger where tgrelid=$1::regclass and tgname in ('event_ticket_service_groups_guard','point_reward_service_groups_guard')",[s+'.event_tickets'])).rows[0].n,1);
   assert.equal((await h.db.query("select count(*)::int n from pg_constraint where conrelid=$1::regclass and conname='point_reward_service_groups_check'",[s+'.point_card_rewards'])).rows[0].n,1);
   for(const role of ['anon','authenticated'])
    assert.equal((await h.db.query("select has_function_privilege($1,$2,'execute') allowed",[role,s+'.booking_meets_required_services(uuid,uuid[],text,jsonb)'])).rows[0].allowed,false);
  }
  // Positive settlement uses the real provisioned base, ledger and transaction.
  const s=fresh.runtime_schema,actor='U'+'8'.repeat(32);
  const one=async(sql,args=[]) => (await h.db.query(sql,args)).rows[0];
  const member=(await one(`insert into ${s}.members(line_user_id,member_code,status,membership_status,is_test_account) values($1,'CONTRACT-QA','active','active',true) returning id`,['U'+'9'.repeat(32)])).id;
  const type=(await one(`insert into ${s}.booking_service_types(name) values('Contract QA') returning id`)).id;
  const card=(await one(`insert into ${s}.point_cards(card_id,title,status,expiry_mode,created_by,updated_by) values('CONTRACT-CARD','QA','active','unlimited',$1,$1) returning id`,[actor])).id;
  await h.db.query(`insert into ${s}.booking_service_type_rewards(service_type_id,point_card_id,minutes_per_point) values($1,$2,30)`,[type,card]);
  const service=(await one(`insert into ${s}.booking_services(title,duration_minutes,price_amount,service_type,created_by) values('QA',60,100,'Contract QA',$1) returning id`,[actor])).id;
  const technician=(await one(`insert into ${s}.booking_technicians(name,is_active) values('QA',true) returning id`)).id;
  await h.db.query(`update ${s}.booking_settings set primary_technician_id=$1`,[technician]);
  const booking=(await one(`select (${s}.create_group_booking_request_v2($1,$2,(now() at time zone 'Asia/Taipei')::date+5,'10:00',$3,'')).id id`,['CONTRACT-'+crypto.randomUUID(),member,JSON.stringify([{technicianId:technician,items:[{serviceId:service,quantity:1}]}])])).id;
  // Controlled fixture clock transition, as in the established settlement suite.
  await h.db.exec(`alter table ${s}.bookings disable trigger user`);
  await h.db.query(`update ${s}.bookings set status='confirmed',booking_date=(now() at time zone 'Asia/Taipei')::date-1 where id=$1`,[booking]);
  await h.db.exec(`alter table ${s}.bookings enable trigger user`);
  await h.db.query(`insert into ${s}.calendar_items(calendar_item_id,title,item_type,status,starts_on,ends_on,bonus_points_enabled,bonus_points,created_by,updated_by) values('CONTRACT-EVENT','QA bonus','event','active',(now() at time zone 'Asia/Taipei')::date-1,(now() at time zone 'Asia/Taipei')::date-1,true,3,$1,$1)`,[actor]);
  const settlement=(await one(`select ${s}.complete_booking_with_rewards_request($1,updated_at,$2,'') value from ${s}.bookings where id=$1`,[booking,actor])).value;
  assert.equal(settlement.calendarBonusTotalPerCard,3);
  assert.equal(settlement.calendarBonusDetails.length,1);
  assert.equal((await one(`select stamps from ${s}.point_balances where member_id=$1 and point_card_id=$2`,[member,card])).stamps,5);
  assert.equal((await one(`select jsonb_array_length(calendar_bonus_details) n from ${s}.booking_completion_settlements where booking_id=$1`,[booking])).n,1);
  await assert.rejects(one(`select ${s}.complete_booking_with_rewards_request($1,updated_at,$2,'') from ${s}.bookings where id=$1`,[booking,actor]),/INVALID_BOOKING_TRANSITION|BOOKING_COMPLETION_ALREADY_SETTLED/);
  assert.equal((await one(`select count(*)::int n from ${s}.point_entries where reference_type='calendar_bonus' and reference_id=$1`,[booking])).n,1);
  assert.equal((await one(`select count(*)::int n from ${old.runtime_schema}.point_entries`)).n,0);
 }finally{await h.db.close();}
};
