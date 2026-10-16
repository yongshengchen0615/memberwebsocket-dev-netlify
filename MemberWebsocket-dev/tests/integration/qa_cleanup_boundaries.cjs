const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const dir = path.join(__dirname, '../../supabase/migrations');
const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
const fix = fs.readdirSync(dir).find(name => name.endsWith('_harden_qa_cleanup_boundaries.sql'));
const evolutionPurgeFix = fs.readdirSync(dir).find(name => name.endsWith('_fix_test_purge_evolution_delete_guard.sql'));
const ticketPurgeFix = fs.readdirSync(dir).find(name => name.endsWith('_fix_qa_ticket_purge_residuals.sql'));
const provenancePurgeFix = fs.readdirSync(dir).find(name => name.endsWith('_fix_single_pass_test_purge_qa_provenance.sql'));

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema booking_notifications; create schema extensions;
    create function extensions.digest(text,text) returns bytea language sql as $$ select decode(md5($1),'hex') $$;
    create table members(id uuid primary key default gen_random_uuid(),is_test_account boolean,line_user_id text,member_code text);
    create table bookings(id uuid primary key default gen_random_uuid(),member_id uuid,service_id uuid,technician_id uuid);
    create table point_transfers(sender_member_id uuid,receiver_member_id uuid,point_card_id uuid);
    create table member_referrals(inviter_member_id uuid,invitee_member_id uuid,reward_event_ticket_id uuid);
    create table automation_test_runs(environment text);
    create table api_rate_limits(principal_hash text);
    create table idempotency_results(actor_line_user_id text,result jsonb);
    create table booking_audit_events(actor_line_user_id text,target_id text,metadata jsonb);
    create table audit_logs(actor_line_user_id text,target_id text,detail jsonb,action text,target_type text);
    create table booking_notifications.outbox(booking_id uuid);
    create table booking_completion_settlements(member_id uuid,booking_id uuid);
    create table birthday_benefit_grants(member_id uuid,event_ticket_id uuid);
    create table event_ticket_claims(member_id uuid,event_ticket_id uuid);
    create table scheduled_grant_messages(member_id uuid,line_user_id text);
    create table point_tickets(member_id uuid,point_card_id uuid,ticket_template_id uuid);
    create table point_entries(member_id uuid,point_card_id uuid);
    create table point_balances(member_id uuid,point_card_id uuid);
    create table service_time_entries(member_id uuid);
    create table fixed_ticket_grants(member_id uuid,event_ticket_id uuid,fixed_ticket_template_id uuid);
    create table test_login_sessions(member_id uuid);
    create table member_presence_sessions(member_id uuid);
    create table calendar_items(id uuid primary key default gen_random_uuid(),created_by text,calendar_item_id text,title text,source_event_ticket_id uuid);
    create table event_tickets(id uuid primary key default gen_random_uuid(),created_by text,event_ticket_id text,title text,fixed_ticket_template_id uuid,referral_source_event_ticket_id uuid references event_tickets(id));
    create table point_cards(id uuid primary key default gen_random_uuid(),created_by text,card_id text,title text);
    create table ticket_templates(id uuid primary key default gen_random_uuid(),created_by text,ticket_template_id text,title text);
    create table point_card_rewards(point_card_id uuid references point_cards(id) on delete cascade,ticket_template_id uuid references ticket_templates(id));
    create table booking_service_type_rewards(created_by text,updated_by text);
    create table booking_services(id uuid primary key default gen_random_uuid(),created_by text,service_type text,deleted_at timestamptz);
    create table booking_items(service_id uuid);
    create table booking_participant_items(service_id uuid);
    create table booking_service_types(id uuid primary key default gen_random_uuid(),name text);
    create table booking_technicians(id uuid primary key default gen_random_uuid(),created_by text,name text,is_active boolean,sort_order int,created_at timestamptz default now(),updated_at timestamptz default now());
    create table booking_participants(technician_id uuid);
    create table booking_participant_reservations(technician_id uuid);
    create table booking_settings(id int primary key,primary_technician_id uuid,updated_by text,updated_at timestamptz default now());
    create table fixed_ticket_templates(id uuid primary key default gen_random_uuid(),created_by text,title text);
    alter table event_tickets add constraint event_tickets_fixed_template_fk foreign key(fixed_ticket_template_id) references fixed_ticket_templates(id);
    alter table fixed_ticket_grants add constraint fixed_grants_template_fk foreign key(fixed_ticket_template_id) references fixed_ticket_templates(id);
    create table realtime_events(event_type text);
    insert into booking_technicians(id,created_by,name,is_active,sort_order) values
      ('10000000-0000-4000-8000-000000000001','admin','正式主要技師',true,5);
    insert into booking_settings values (1,'10000000-0000-4000-8000-000000000001','admin','2026-01-01');
    insert into booking_service_types(name) values ('E2E QA 正式服務類型');
    insert into fixed_ticket_templates(created_by,title) values ('admin','E2E QA 正式固定券');
    insert into booking_service_type_rewards values ('admin','qa:e2e:probe');
  `);
  for (const [table, id] of [['calendar_items','calendar_item_id'],['event_tickets','event_ticket_id'],
    ['point_cards','card_id'],['ticket_templates','ticket_template_id']]) {
    await db.exec(`insert into ${table}(created_by,${id},title) values
      ('admin','QA-real','QA 正式資源'),('qa:e2e:fixture','fixture','測試來源資源');`);
  }
  await db.exec(read('20261001134258_purge_test_growth_transfer_dependencies.sql'));
  await db.exec(read('20260923150806_self_contained_test_purge_booking_baseline.sql'));
  return db;
}

test('reproduces legacy name-based deletion and configured primary technician reset', async () => {
  const db = await fixture();
  try {
    await db.query('select admin_purge_test_data()');
    assert.equal((await db.query('select count(*)::int n from ticket_templates')).rows[0].n, 0);
    await db.query('select admin_purge_extended_qa_artifacts()');
    assert.notEqual((await db.query('select primary_technician_id from booking_settings')).rows[0].primary_technician_id,
      '10000000-0000-4000-8000-000000000001');
  } finally { await db.close(); }
});

test('QA purge preserves namesake formal resources, settings and ambiguous provenance', async () => {
  const db = await fixture();
  try {
    await db.exec(read(fix));
    const before = (await db.query('select * from booking_settings')).rows;
    for (const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select admin_purge_test_data()'), /permission denied/);
      await assert.rejects(db.query('select admin_purge_extended_qa_artifacts()'), /permission denied/);
      await db.exec('reset role');
    }
    await db.query('select admin_purge_test_data()');
    await db.query('select admin_purge_extended_qa_artifacts()');
    for (const table of ['calendar_items','event_tickets','point_cards','ticket_templates']) {
      assert.deepEqual((await db.query(`select created_by,title from ${table}`)).rows,
        [{ created_by: 'admin', title: 'QA 正式資源' }]);
    }
    assert.deepEqual((await db.query('select * from booking_settings')).rows, before);
    assert.equal((await db.query('select count(*)::int n from booking_service_types')).rows[0].n, 1);
    assert.equal((await db.query('select count(*)::int n from fixed_ticket_templates')).rows[0].n, 1);
    assert.equal((await db.query('select count(*)::int n from booking_service_type_rewards')).rows[0].n, 1);
    await db.query('select admin_purge_test_data()');
    await db.query('select admin_purge_extended_qa_artifacts()');
    assert.deepEqual((await db.query('select * from booking_settings')).rows, before, 'repeated cleanup is safe');
  } finally { await db.close(); }
});

test('removing a QA primary repairs the baseline without keeping QA configuration', async () => {
  const db = await fixture();
  try {
    await db.exec(read(fix));
    await db.exec(`insert into booking_technicians(id,created_by,name,is_active,sort_order) values
      ('10000000-0000-4000-8000-000000000002','qa:e2e:fixture','QA 技師',true,1);
      update booking_settings set primary_technician_id='10000000-0000-4000-8000-000000000002';`);
    await db.query('select admin_purge_extended_qa_artifacts()');
    const primary = (await db.query('select t.* from booking_settings s join booking_technicians t on t.id=s.primary_technician_id')).rows[0];
    assert.equal(primary.created_by, 'system');
    assert.equal(primary.is_active, true);
    assert.equal((await db.query("select count(*)::int n from booking_technicians where created_by like 'qa:%'")).rows[0].n, 0);
  } finally { await db.close(); }
});


test('all-test purge uses a guarded singleton delete for E2E evolution state', () => {
  const sql = read(evolutionPurgeFix);
  assert.match(sql, /delete\s+from\s+public\.e2e_evolution_state\s+where\s+id\s*=\s*true\s*;/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.e2e_evolution_state\s*;/i);
});

test('test purge removes QA point-card rewards and fixed-ticket automation descendants without touching formal data', async () => {
  const db = await fixture();
  try {
    await db.exec(read(fix));
    await db.exec(read(ticketPurgeFix));
    await db.exec(read(provenancePurgeFix));

    const qaCardId = '20000000-0000-4000-8000-000000000001';
    const qaTemplateId = '20000000-0000-4000-8000-000000000002';
    const qaFixedId = '20000000-0000-4000-8000-000000000003';
    const generatedEventId = '20000000-0000-4000-8000-000000000004';

    await db.exec(`
      insert into point_cards(id,created_by,card_id,title)
      values ('${qaCardId}','qa-ui:fixture','QA-PC','QA 集點卡');
      insert into ticket_templates(id,created_by,ticket_template_id,title)
      values ('${qaTemplateId}','qa-state:fixture','QA-TPL','QA 票券模板');
      insert into point_card_rewards(point_card_id,ticket_template_id)
      values ('${qaCardId}','${qaTemplateId}');
      insert into fixed_ticket_templates(id,created_by,title)
      values ('${qaFixedId}','qa:e2e:fixture','E2E QA 固定票券');
      insert into event_tickets(id,created_by,event_ticket_id,title,fixed_ticket_template_id)
      values ('${generatedEventId}','fixed-ticket-automation','FIXED-QA','E2E QA 固定票券','${qaFixedId}');
    `);

    await db.query('select admin_purge_test_data()');
    await db.query('select admin_purge_extended_qa_artifacts()');

    assert.equal((await db.query(`select count(*)::int n from point_cards where id='${qaCardId}'`)).rows[0].n, 0);
    assert.equal((await db.query(`select count(*)::int n from ticket_templates where id='${qaTemplateId}'`)).rows[0].n, 0);
    assert.equal((await db.query(`select count(*)::int n from fixed_ticket_templates where id='${qaFixedId}'`)).rows[0].n, 0);
    assert.equal((await db.query(`select count(*)::int n from event_tickets where fixed_ticket_template_id='${qaFixedId}'`)).rows[0].n, 0);

    assert.equal((await db.query("select count(*)::int n from point_cards where created_by='admin'")).rows[0].n, 1);
    assert.equal((await db.query("select count(*)::int n from ticket_templates where created_by='admin'")).rows[0].n, 1);
    assert.equal((await db.query("select count(*)::int n from fixed_ticket_templates where created_by='admin'")).rows[0].n, 1);
  } finally { await db.close(); }
});


test('canonical QA provenance recognizes colon, ui and state families and converged purge is bounded', () => {
  const sql = read(provenancePurgeFix);
  assert.match(sql, /p_value like 'qa:%'/);
  assert.match(sql, /p_value like 'qa-ui:%'/);
  assert.match(sql, /p_value like 'qa-state:%'/);
  assert.match(sql, /for v_passes in 1\.\.4 loop/);
  assert.match(sql, /'cleanupComplete'/);
  assert.match(sql, /'remainingQaArtifacts'/);
});
