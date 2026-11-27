const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const database = require('./database.cjs');
const fixture = require('../business-runtime-fixture.cjs');
const root = path.resolve(__dirname,'../../../supabase/migrations');
const migrations = [
  '20261030050000_ticket_booking_service_groups.sql',
  '20261110184500_general_event_ticket_amount_gate.sql',
  '20261118094500_event_ticket_amount_requires_booking.sql',
  '20261127160000_activity_ticket_booking_rules.sql',
].map(name => fs.readFileSync(path.join(root,name),'utf8'));
const uuid = randomUUID;

test('PG17 AC-PARTY-001..007: ticket min/max, member ownership, no bypass, tenant blueprint, activity rule data contract',async t=>{
  const h=await fixture({...await database()});
  try{
    const actor='U'+'8'.repeat(32);
    const tenant=await h.approve(actor,'party-existing-'+uuid().slice(0,8));
    for(const script of migrations) await h.db.exec(script);
    for(const s of ['public',tenant.runtime_schema]){
      await t.test(s+' new columns, constraints and RPC privileges',async()=>{
        const columns=(await h.db.query(
          "select table_name,column_name from information_schema.columns where table_schema=$1 and (table_name='event_tickets' or table_name='calendar_items') and column_name in ('min_booking_party_size','max_booking_party_size','usage_conditions')",
          [s]
        )).rows;
        assert.equal(columns.length,3);
        const perm=(await h.db.query(
          "select has_function_privilege('anon',$1,'EXECUTE') denied,has_function_privilege('authenticated',$1,'EXECUTE') signed_in,has_function_privilege('service_role',$1,'EXECUTE') accepted",
          [s+'.booking_ticket_meets_party_size(uuid,uuid,text,text)']
        )).rows[0];
        assert.deepEqual(perm,{denied:false,signed_in:false,accepted:true});
        const checks=(await h.db.query(
          "select conname from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname=$1 and conname in ('event_ticket_party_size_check','calendar_usage_conditions_check')",
          [s]
        )).rows;
        assert.equal(checks.length,2);
        const source=(await h.db.query("select pg_get_functiondef($1::regprocedure) def",[s+'.booking_ticket_meets_amount(uuid,uuid,text,text)'])).rows[0].def;
        assert.match(source,/booking_ticket_meets_party_size/);
        const calendar=(await h.db.query("select pg_get_functiondef($1::regprocedure) def",[s+'.apply_calendar_batch(text,jsonb)'])).rows[0].def;
        assert.match(calendar,/usage_conditions/);
      });
    }
    const s=tenant.runtime_schema;
    const tech=(await h.db.query('insert into '+s+".booking_technicians(name,is_active) values('Party QA tech',true) returning id")).rows[0].id;
    await h.db.query('update '+s+'.booking_settings set primary_technician_id=$1',[tech]);
    await h.db.query('insert into '+s+".booking_service_types(name) values('Party QA')");
    const service=uuid();
    await h.db.query('insert into '+s+'.booking_services(id,title,duration_minutes,price_amount,is_active,service_type,created_by) values($1,$2,30,100,true,$3,$4)',[service,'Party QA service','Party QA','system']);
    const lineUserId='U'+'7'.repeat(32);
    const member=(await h.db.query('insert into '+s+".members(line_user_id,display_name,member_code,membership_status,status,is_test_account) values($1,$2,$3,'active','active',true) returning id",[lineUserId,'Party QA','PTY-'+uuid().slice(0,8)])).rows[0].id;
    await h.db.query('update '+s+'.members set is_test_account=false where id=$1',[member]);
    const date=(await h.db.query("select ((now() at time zone 'Asia/Taipei')::date + 7)::text d")).rows[0].d;
    const booking=(await h.db.query('select ('+s+'.create_group_booking_request_v2($1,$2,$3,$4,$5,$6)).id id',[
      'PARTY-'+uuid(),member,date,'10:00',JSON.stringify([{technicianId:tech,items:[{serviceId:service,quantity:1}]}]),''
    ])).rows[0].id;
    const ticket=(await h.db.query('insert into '+s+".event_tickets(event_ticket_id,title,ticket_type,status,created_by,updated_by,min_booking_party_size,max_booking_party_size) values($1,'Party QA','coupon','active','system','system',2,4) returning id",['PARTY-'+uuid()])).rows[0].id;
    await h.db.query('insert into '+s+".event_ticket_claims(claim_id,event_ticket_id,member_id,ticket_type,ticket_title) values('PARTY-CLAIM',$1,$2,'coupon','Party QA')",[ticket,member]);
    const eligible=async (id=booking,m=member)=> (await h.db.query(
      'select '+s+'.booking_ticket_meets_amount($1,$2,$3,$4) value',
      [id,m,'event','PARTY-CLAIM']
    )).rows[0].value;
    await t.test('ticket is not usable without a booking, by another member or under 2 persons',async()=>{
      assert.equal(await eligible(null),false);
      assert.equal(await eligible(booking,uuid()),false);
      assert.equal(await eligible(),false);
      const options=(await h.db.query('select '+s+'.member_ticket_booking_options($1::uuid) x',[member])).rows[0].x;
      assert.equal((options.event?.['PARTY-CLAIM'] || []).some(v=>v.bookingId==='no-booking'),false);
    });
    await t.test('2–4 inclusive; 1/5 rejected; removing bounds restores direct eligibility',async()=>{
      for(const [people,expected] of [[1,false],[2,true],[3,true],[4,true],[5,false]]){
        await h.db.query('update '+s+'.bookings set party_size=$2 where id=$1',[booking,people]);
        assert.equal(await eligible(),expected,'party size '+people);
      }
      await h.db.query('update '+s+'.event_tickets set min_booking_party_size=0,max_booking_party_size=0 where id=$1',[ticket]);
      assert.equal(await eligible(null),true);
    });
    await t.test('invalid range cannot be committed and does not change persisted data',async()=>{
      await assert.rejects(h.db.query('update '+s+'.event_tickets set min_booking_party_size=5,max_booking_party_size=3 where id=$1',[ticket]),/event_ticket_party_size_check/);
      await assert.rejects(h.db.query('update '+s+'.event_tickets set min_booking_party_size=-1 where id=$1',[ticket]),/event_ticket_party_size_check/);
      assert.equal((await h.db.query('select min_booking_party_size from '+s+'.event_tickets where id=$1',[ticket])).rows[0].min_booking_party_size,0);
    });
    const good={requiredServiceIds:[service],requiredServiceMatchMode:'all',requiredServiceGroups:[],minBookingAmountMode:'total',minBookingAmount:100,minBookingServiceIds:[],minBookingPartySize:2,maxBookingPartySize:4};
    await t.test('calendar activity conditions validate and persist, malformed formats rejected',async()=>{
      assert.equal((await h.db.query('select '+s+'.calendar_usage_conditions_valid($1::jsonb) value',[JSON.stringify(good)])).rows[0].value,true);
      assert.equal((await h.db.query('select '+s+'.calendar_usage_conditions_valid($1::jsonb) value',[JSON.stringify({...good,minBookingPartySize:5})])).rows[0].value,false);
      const id='PARTY-CALENDAR-'+uuid();
      await h.db.query('insert into '+s+".calendar_items(calendar_item_id,title,item_type,status,starts_on,usage_conditions) values($1,'Party member activity','event','active',$2,$3::jsonb)",[id,date,JSON.stringify(good)]);
      assert.deepEqual((await h.db.query('select usage_conditions rule from '+s+'.calendar_items where calendar_item_id=$1',[id])).rows[0].rule,good);
      await assert.rejects(h.db.query('update '+s+'.calendar_items set usage_conditions=$2::jsonb where calendar_item_id=$1',[id,JSON.stringify({...good,maxBookingPartySize:1})]),/calendar_usage_conditions_check/);
    });
    await t.test('new tenant blueprint provisions new fields and helpers',async()=>{
      const next=await h.approve('U'+'6'.repeat(32),'party-future-'+uuid().slice(0,8));
      const n=next.runtime_schema;
      const fields=(await h.db.query(
        "select column_name from information_schema.columns where table_schema=$1 and column_name in ('min_booking_party_size','max_booking_party_size','usage_conditions')",
        [n]
      )).rows;
      assert.equal(fields.length,3);
      const check=(await h.db.query('select '+n+".calendar_usage_conditions_valid('{}'::jsonb) value")).rows[0].value;
      assert.equal(check,true);
      const func=(await h.db.query('select to_regprocedure($1) f',[n+'.booking_ticket_meets_party_size(uuid,uuid,text,text)'])).rows[0].f;
      assert.ok(func);
    });
  }finally{await h.db.close();}
});
