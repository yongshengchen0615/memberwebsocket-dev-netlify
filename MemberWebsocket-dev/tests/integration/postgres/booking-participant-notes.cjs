'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const database=require('./database.cjs');
const fixture=require('../business-runtime-fixture.cjs');

const migration=fs.readFileSync(path.resolve(__dirname,'../../../supabase/migrations/20261109115000_booking_participant_individual_notes.sql'),'utf8');
const id=n=>'U'+String(n).repeat(32);
const serviceId='50000000-0000-4000-8000-000000000072';

test('AC-PNOTE-001..006: notes survive existing-tenant upgrade, multiple people, edit, guard and future tenants',async()=>{
  const h=await fixture({...await database()});
  try {
    const tenant=await h.approve(id(5),'individual-notes-'+crypto.randomUUID().slice(0,8));
    const schema=tenant.runtime_schema;
    assert.equal((await h.db.query(
      'select count(*)::int n from information_schema.columns where table_schema=$1 and table_name=$2 and column_name=$3',
      [schema,'booking_participants','member_note'])).rows[0].n,0);

    await h.db.query('insert into '+schema+".booking_service_types(name) values('個別備註服務')");
    await h.db.query('insert into '+schema+
      ".booking_services(id,title,duration_minutes,price_amount,is_active,service_type,created_by) values($1,'服務',30,100,true,'個別備註服務','system')",[serviceId]);
    const techs=(await h.db.query('insert into '+schema+
      ".booking_technicians(name,is_active) values('技師甲',true),('技師乙',true) returning id")).rows.map(x=>x.id);
    await h.db.query('update '+schema+'.booking_settings set primary_technician_id=$1,max_party_size=2 where id=1',[techs[0]]);
    const member=(await h.db.query('insert into '+schema+
      ".members(line_user_id,display_name,member_code,membership_status,status,is_test_account) values($1,'測試會員','NOTE-QA-001','active','active',true) returning id",[id(6)])).rows[0].id;
    await h.db.query('update '+schema+'.members set is_test_account=false where id=$1',[member]);
    const bookingDate=(await h.db.query("select ((now() at time zone 'Asia/Taipei')::date+5)::text value")).rows[0].value;
    const participants=(notes)=>[
      {technicianId:techs[0],items:[{serviceId,quantity:1}],...(notes ? {memberNote:notes[0]} : {})},
      {technicianId:techs[1],items:[{serviceId,quantity:1}],...(notes ? {memberNote:notes[1]} : {})},
    ];
    const create=async(notes,rootNote,time)=>(
      await h.db.query('select ('+schema+'.create_group_booking_request_v2($1,$2,$3,$4,$5,$6)).id value',
        ['BOOK-'+crypto.randomUUID(),member,bookingDate,time,JSON.stringify(participants(notes)),rootNote])
    ).rows[0].value;
    const legacy=await create(null,'舊版整筆備註','10:00');
    await h.db.exec(migration);
    const column=(await h.db.query('select column_default,is_nullable from information_schema.columns where table_schema=$1 and table_name=$2 and column_name=$3',
      [schema,'booking_participants','member_note'])).rows[0];
    assert.equal(column.is_nullable,'NO');
    assert.ok(column.column_default.includes("''"),'new participants should default to empty string');
    const lookup=async(bookingId)=>(await h.db.query('select position,member_note from '+schema+
      '.booking_participants where booking_id=$1 order by position',[bookingId])).rows;
    assert.deepEqual((await lookup(legacy)).map(x=>x.member_note),['舊版整筆備註','']);
    const created=await create(['第一位怕冷','第二位力道輕'],'','11:00');
    assert.deepEqual((await lookup(created)).map(x=>x.member_note),['第一位怕冷','第二位力道輕']);

    const version=(await h.db.query('select updated_at from '+schema+'.bookings where id=$1',[created])).rows[0].updated_at;
    await h.db.query('select ('+schema+'.update_group_booking_request_v2($1,$2,$3,$4,$5,$6,$7,$8,$9)).id',
      [created,version,id(6),'BOOK-'+crypto.randomUUID(),member,bookingDate,'11:00',JSON.stringify(participants(['第一位改備註','第二位仍獨立'])),'']);
    assert.deepEqual((await lookup(created)).map(x=>x.member_note),['第一位改備註','第二位仍獨立']);
    const participant=(await h.db.query('select id from '+schema+'.booking_participants where booking_id=$1 and position=1',[created])).rows[0].id;
    await assert.rejects(h.db.query('update '+schema+'.booking_participants set member_note=$1 where id=$2',
      ['X'.repeat(501),participant]),/booking_participants_member_note_length_check/);
    assert.equal((await lookup(created))[0].member_note,'第一位改備註');

    const future=await h.approve(id(7),'individual-notes-future-'+crypto.randomUUID().slice(0,8));
    const newSchema=future.runtime_schema;
    const futureColumn=(await h.db.query('select count(*)::int n from information_schema.columns where table_schema=$1 and table_name=$2 and column_name=$3',
      [newSchema,'booking_participants','member_note'])).rows[0].n;
    assert.equal(futureColumn,1,'new merchant must receive member_note from updated template');
    assert.match((await h.db.query('select pg_get_functiondef($1::regprocedure) def',
      [newSchema+'.create_group_booking_request_v2(text,uuid,date,time without time zone,jsonb,text,text,text,text,text)'])).rows[0].def,/member_note\s*=\s*CASE/);
    assert.equal((await h.db.query('select count(*)::int n from information_schema.columns where table_schema=$1 and table_name=$2 and column_name=$3',
      ['public','booking_participants','member_note'])).rows[0].n,1);
  } finally {await h.db.close();}
});
