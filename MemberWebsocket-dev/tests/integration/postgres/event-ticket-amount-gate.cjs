const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const database = require('./database.cjs');
const fixture = require('../business-runtime-fixture.cjs');
const root = path.resolve(__dirname, '../../../supabase/migrations');
const groupMigration = fs.readFileSync(path.join(root,'20261030050000_ticket_booking_service_groups.sql'),'utf8');
const migration = fs.readFileSync(path.join(root,'20261110184500_general_event_ticket_amount_gate.sql'),'utf8');
const uuid = () => crypto.randomUUID();

test('PG17 AC-AMOUNT-001..009: actual migration, existing and future tenant, thresholds, roles and snapshot isolation',async t=>{
 const h=await fixture({...await database()});
 try {
   const actor = 'U'+'8'.repeat(32);
   const tenant = await h.approve(actor,'amount-existing-'+uuid().slice(0,8));
   await h.db.exec(groupMigration);
   await h.db.exec(migration);
   const names=['public',tenant.runtime_schema];
   for(const s of names){
     await t.test(s+' new fields and internal authorization',async()=>{
       const c=(await h.db.query('select column_name,column_default from information_schema.columns where table_schema=$1 and table_name=$2 and column_name like $3 order by column_name',[s,'event_tickets','min_booking_%'])).rows;
       assert.equal(c.length,3);
       const perm=(await h.db.query(
         "select has_function_privilege('anon',$1,'EXECUTE') denied,has_function_privilege('service_role',$1,'EXECUTE') accepted",
         [s+'.booking_ticket_meets_amount(uuid,uuid,text,text)'])).rows[0];
       assert.deepEqual(perm,{denied:false,accepted:true});
       const check=await h.db.query('select conname from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname=$1 and t.relname=$2 and conname=$3',[s,'event_tickets','event_ticket_min_booking_amount_check']);
       assert.equal(check.rows.length,1);
       const trigger=await h.db.query('select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=$2 and tgname=$3',[s,'event_tickets','event_ticket_min_booking_services_guard']);
       assert.equal(trigger.rows.length,1);
     });
   }
   const s=tenant.runtime_schema, ids=[uuid(),uuid()];
   await h.db.query('insert into '+s+".booking_service_types(name) values('Amount QA')");
   for(const [i,id] of ids.entries()){
     await h.db.query('insert into '+s+'.booking_services(id,title,duration_minutes,price_amount,is_active,service_type,created_by) values($1,$2,30,$3,true,$4,$5)',[id,'Amount QA '+i,i===0?150:200,'Amount QA','system']);
   }
   const tech=(await h.db.query('insert into '+s+".booking_technicians(name,is_active) values('Amount QA tech',true) returning id")).rows[0].id;
   await h.db.query('update '+s+'.booking_settings set primary_technician_id=$1',[tech]);
   const member=(await h.db.query('insert into '+s+'.members(line_user_id,display_name,member_code,membership_status,status,is_test_account) values($1,$2,$3,$4,$5,true) returning id',['U'+'7'.repeat(32),'Amount QA','AMT-'+uuid().slice(0,8),'active','active'])).rows[0].id;
   await h.db.query('update '+s+'.members set is_test_account=false where id=$1',[member]);
   const date=(await h.db.query("select ((now() at time zone 'Asia/Taipei')::date + 5)::text d")).rows[0].d;
   const booking=(await h.db.query('select ('+s+'.create_group_booking_request_v2($1,$2,$3,$4,$5,$6)).id id',
      ['BOOK-'+uuid(),member,date,'10:00',JSON.stringify([{technicianId:tech,items:[{serviceId:ids[0],quantity:1},{serviceId:ids[1],quantity:2}]}]),''])).rows[0].id;
   const ticket=(await h.db.query('insert into '+s+".event_tickets(event_ticket_id,title,ticket_type,status,created_by,updated_by,min_booking_amount_mode,min_booking_amount) values($1,$2,$3,$4,$5,$6,'total',550) returning id",
      ['AMT-'+uuid(),'Amount QA','coupon','active','system','system'])).rows[0].id;
   await h.db.query('insert into '+s+".event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title) values($1,$2,$3,'coupon','Amount QA')",['AMT-CLAIM',ticket,member]);
   const met=async()=> (await h.db.query('select '+s+'.booking_ticket_meets_amount($1,$2,$3,$4) allowed',[booking,member,'event','AMT-CLAIM'])).rows[0].allowed;
   await t.test('exact total threshold, quantity and selected subtotal',async()=>{
     assert.equal(await met(),true);
     await h.db.query('update '+s+'.event_tickets set min_booking_amount=551 where id=$1',[ticket]);
     assert.equal(await met(),false);
     await h.db.query('update '+s+".event_tickets set min_booking_amount_mode='selected_services',min_booking_amount=400,min_booking_service_ids=$2 where id=$1",[ticket,[ids[1]]]);
     assert.equal(await met(),true);
     await h.db.query('update '+s+'.event_tickets set min_booking_amount=401 where id=$1',[ticket]);
     assert.equal(await met(),false);
   });
   await t.test('server denial; borrowed member and forged ticket are not valid',async()=>{
     await assert.rejects(h.db.query('select '+s+'.assert_general_booking_event_amount($1,$2,$3::jsonb)',[booking,member,JSON.stringify([{kind:'event',id:'AMT-CLAIM'}])]),/BOOKING_BENEFIT_AMOUNT_REQUIRED/);
     const other=uuid();
     assert.equal((await h.db.query('select '+s+'.booking_ticket_meets_amount($1,$2,$3,$4) allowed',[booking,other,'event','AMT-CLAIM'])).rows[0].allowed,false);
     assert.equal((await h.db.query('select '+s+'.booking_ticket_meets_amount($1,$2,$3,$4) allowed',[booking,member,'event','AMT-FAKE'])).rows[0].allowed,false);
   });
   await t.test('invalid referenced item and deleting a referenced service are rejected',async()=>{
     await assert.rejects(h.db.query('update '+s+'.event_tickets set min_booking_service_ids=$2 where id=$1',[ticket,[uuid()]]),/INVALID_BOOKING_AMOUNT_RULE/);
     await assert.rejects(h.db.query('delete from '+s+'.booking_services where id=$1',[ids[1]]),/BOOKING_SERVICE_IN_USE/);
   });
   await t.test('snapshot receipt and standalone ticket use remain unchanged',async()=>{
     const funcs=(await h.db.query("select p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname in ('validate_snapshot_ticket_selection','ticket_has_service_requirement','register_accessible_receipt_with_benefits_request')",[s])).rows;
     assert.ok(funcs.length>=3);
     assert.equal(funcs.some(f=>f.definition.includes('booking_ticket_meets_amount')),false);
   });
   await t.test('new tenant is provisioned with amount rule fields and helpers',async()=>{
     const another=await h.approve('U'+'6'.repeat(32),'amount-future-'+uuid().slice(0,8));
     const n=another.runtime_schema;
     const rows=(await h.db.query('select column_name from information_schema.columns where table_schema=$1 and table_name=$2 and column_name like $3',[n,'event_tickets','min_booking_%'])).rows;
     assert.equal(rows.length,3);
     const fn=(await h.db.query("select to_regprocedure($1) as function",[n+'.booking_ticket_meets_amount(uuid,uuid,text,text)'])).rows[0].function;
     assert.ok(fn);
   });
 }finally {await h.db.close();}
});
