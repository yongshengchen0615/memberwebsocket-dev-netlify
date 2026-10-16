const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {PGlite}=require('@electric-sql/pglite');
test('QA event-day fixture advances only owner QA UI claims and never alters daily limits or formal history',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
      create table members(id uuid primary key,is_test_account boolean,status text,membership_status text);
      create table event_tickets(id int primary key,event_ticket_id text,created_by text,deleted_at timestamptz);
      create table event_ticket_claims(event_ticket_id int,member_id uuid,status text,used_at timestamptz,updated_at timestamptz);
      create table event_ticket_settings(max_tickets_per_day int);insert into event_ticket_settings values(1);
      insert into members values('00000000-0000-0000-0000-000000000001',true,'active','active'),('00000000-0000-0000-0000-000000000002',false,'active','active'),('00000000-0000-0000-0000-000000000003',true,'active','active');
      insert into event_tickets values(1,'QA-UI-EVT-A','qa-ui:00000000-0000-0000-0000-000000000001:ABCDEF1234567890',null),
        (2,'FORMAL','formal-admin',null),(3,'QA-UI-EVT-B','qa-ui:00000000-0000-0000-0000-000000000003:ABCDEF1234567890',null);
      insert into event_ticket_claims values(1,'00000000-0000-0000-0000-000000000001','used',now(),now()),
        (2,'00000000-0000-0000-0000-000000000001','used',now(),now()),
        (1,'00000000-0000-0000-0000-000000000003','used',now(),now()),
        (3,'00000000-0000-0000-0000-000000000003','used',now(),now());`);
    await db.exec(fs.readFileSync(path.join(__dirname,'../../supabase/migrations/20261004053220_qa_event_redemption_day_fixture.sql'),'utf8'));
    const call=(mid,tag='ABCDEF1234567890')=>db.query('select prepare_e2e_event_redemption_day($1,$2) value',[mid,tag]);
    await assert.rejects(call('00000000-0000-0000-0000-000000000002'),/TEST_ACCOUNT_REQUIRED/);
    await assert.rejects(call('00000000-0000-0000-0000-000000000001','BAD'),/INVALID_QA_FIXTURE/);
    await assert.rejects(call('00000000-0000-0000-0000-000000000001','1234567890ABCDEF'),/QA_FIXTURE_NOT_OWNED/);
    assert.equal((await call('00000000-0000-0000-0000-000000000001')).rows[0].value.qaHistoryMoved,1);
    assert.equal((await call('00000000-0000-0000-0000-000000000001')).rows[0].value.qaHistoryMoved,0);
    assert.equal((await db.query("select count(*)::int n from event_ticket_claims where (used_at at time zone 'Asia/Taipei')::date=(now() at time zone 'Asia/Taipei')::date")).rows[0].n,3);
    assert.equal((await db.query('select max_tickets_per_day from event_ticket_settings')).rows[0].max_tickets_per_day,1);
    assert.equal((await db.query("select has_function_privilege('anon','prepare_e2e_event_redemption_day(uuid,text)','execute') allowed")).rows[0].allowed,false);
  }finally{await db.close();}
});
