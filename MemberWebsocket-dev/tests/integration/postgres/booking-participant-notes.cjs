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

test('AC-PNOTE-007: member removal erases notes on surviving friend bookings but not unrelated bookings',async()=>{
  const h=await fixture({...await database()});
  try {
    const tenant=await h.approve(id(5),'individual-notes-removal-'+crypto.randomUUID().slice(0,7));
    await h.db.exec(migration);
    const s=tenant.runtime_schema;
    const removalMigration=fs.readFileSync(path.resolve(__dirname,
      '../../../supabase/migrations/20261109123500_member_removal_scrub_participant_notes.sql'),'utf8');
    await h.db.exec(removalMigration);
    const functionDef=(await h.db.query('select pg_get_functiondef($1::regprocedure) def',
      [s+'.finish_member_removal(text,uuid)'])).rows[0].def;
    assert.match(functionDef,/update booking_participants\s+set member_note=''/);
    const rights=(await h.db.query(
      "select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('service_role',$1,'execute') service",
      [s+'.finish_member_removal(text,uuid)'])).rows[0];
    assert.deepEqual(rights,{anon:false,service:true});

    await h.db.query('insert into '+s+".booking_service_types(name) values('Removal services')");
    await h.db.query('insert into '+s+
      ".booking_services(id,title,duration_minutes,price_amount,is_active,service_type,created_by) values($1,'Removal service',30,100,true,'Removal services','system')",[serviceId]);
    const tech=(await h.db.query('insert into '+s+
      ".booking_technicians(name,is_active) values('Removal technician',true) returning id")).rows[0].id;
    await h.db.query('update '+s+'.booking_settings set primary_technician_id=$1 where id=1',[tech]);
    const makeMember=async(n,code)=>{
      const row=(await h.db.query('insert into '+s+
        ".members(line_user_id,display_name,member_code,membership_status,status,is_test_account) values($1,'Removal QA', $2,'active','active',true) returning id",
        [id(n),code])).rows[0];
      await h.db.query('update '+s+'.members set is_test_account=false where id=$1',[row.id]);
      return row.id;
    };
    const memberA=await makeMember(6,'NOTE-REMAIN-A');
    const memberB=await makeMember(7,'NOTE-REMOVE-B');
    const date=(await h.db.query("select ((now() at time zone 'Asia/Taipei')::date+5)::text d")).rows[0].d;
    const create=async(owner,time,note)=>{
      const parts=JSON.stringify([{technicianId:tech,items:[{serviceId,quantity:1}],memberNote:note}]);
      return (await h.db.query('select ('+s+'.create_group_booking_request_v2($1,$2,$3,$4,$5,$6)).id value',
        ['BOOK-'+crypto.randomUUID(),owner,date,time,parts,'root '+note])).rows[0].value;
    };
    const actorRemoved=await create(memberB,'10:00','PRIVATE actor removal');
    const recipientRemoved=await create(memberA,'11:00','PRIVATE recipient removal');
    const unrelated=await create(memberA,'12:00','KEEP unrelated note');
    await h.db.query('update '+s+'.bookings set service_recipient_member_id=$1 where id=$2',
      [memberA,actorRemoved]);
    await h.db.query('update '+s+'.bookings set service_recipient_member_id=$1 where id=$2',
      [memberB,recipientRemoved]);
    const participantNotes=async(bookingId)=>(await h.db.query(
      'select p.member_note note from '+s+'.booking_participants p where p.booking_id=$1 order by p.position',[bookingId])).rows.map(x=>x.note);
    assert.deepEqual(await participantNotes(actorRemoved),['PRIVATE actor removal']);
    assert.deepEqual(await participantNotes(recipientRemoved),['PRIVATE recipient removal']);

    const begun=(await h.db.query('select '+s+'.begin_member_removal($1,$2,$3) result',
      [id(5),id(7),'NOTE-REMOVE-B'])).rows[0].result;
    assert.equal(begun.state,'deleting');
    await assert.rejects(h.db.query('select '+s+'.finish_member_removal($1,$2)',
      [id(9),begun.jobId]),/ADMIN_REQUIRED/);
    const done=(await h.db.query('select '+s+'.finish_member_removal($1,$2) result',
      [id(5),begun.jobId])).rows[0].result;
    assert.equal(done.state,'complete');
    assert.deepEqual(await participantNotes(actorRemoved),['']);
    assert.deepEqual(await participantNotes(recipientRemoved),['']);
    assert.deepEqual(await participantNotes(unrelated),['KEEP unrelated note']);
    const surviving=(await h.db.query('select id,member_note,admin_note,member_id,service_recipient_member_id from '+s+
      '.bookings where id=any($1::uuid[]) order by id',
      [[actorRemoved,recipientRemoved]])).rows;
    assert.equal(surviving.length,2,'both shared reservations remain');
    assert.ok(surviving.every(x=>x.member_note===''&&x.admin_note===''));
    assert.ok(surviving.every(x=>x.member_id!==memberB&&x.service_recipient_member_id!==memberB));
    assert.equal((await h.db.query('select count(*)::int n from '+s+'.members where id=$1',[memberB])).rows[0].n,0);
    assert.equal((await h.db.query('select member_note from '+s+'.bookings where id=$1',[unrelated])).rows[0].member_note,
      'root KEEP unrelated note');

    const future=await h.approve(id(8),'individual-notes-removal-future-'+crypto.randomUUID().slice(0,7));
    const futureDef=(await h.db.query('select pg_get_functiondef($1::regprocedure) def',
      [future.runtime_schema+'.finish_member_removal(text,uuid)'])).rows[0].def;
    assert.match(futureDef,/update booking_participants\s+set member_note=''/,
      'new merchant must inherit note cleanup');
  } finally {await h.db.close();}
});
