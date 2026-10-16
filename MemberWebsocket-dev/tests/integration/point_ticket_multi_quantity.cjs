const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./fixtures/load-postgres-snapshot.cjs');
const migration = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261016151843_allow_multiple_point_reward_tickets.sql'), 'utf8');

test('AC-004: PostgreSQL issues distinct point reward tickets up to balance and stays idempotent', async () => {
  const db = await load();
  try {
    // The isolated baseline snapshot predates snapshot-copy tracking, unlike the live schema.
    await db.exec('alter table public.point_tickets add column if not exists snapshot_reservation_copy_of text;');
    await db.exec(migration);
    await db.exec('select maintenance.ensure_required_system_baseline();');
    const rows = (sql, values = []) => db.query(sql, values).then(r => r.rows);
    const member = (await rows("insert into members(line_user_id,member_code,status,membership_status,is_test_account) values('test:quantity','QA-QTY','active','active',true) returning id"))[0].id;
    const card = (await rows("insert into point_cards(card_id,title,status,created_by,updated_by) values('QA-QTY-CARD','QA card','active','test:admin','test:admin') returning id"))[0].id;
    const template = (await rows("insert into ticket_templates(ticket_template_id,title,ticket_type,status,created_by,updated_by) values('QA-QTY-TEMPLATE','QA coupon','coupon','active','test:admin','test:admin') returning id"))[0].id;
    const reward = (await rows("insert into point_card_rewards(reward_id,point_card_id,threshold_stamps,ticket_template_id) values('QA-QTY-REWARD',$1,5,$2) returning id",[card,template]))[0].id;
    await rows('insert into point_balances(member_id,point_card_id,stamps) values($1,$2,15)',[member,card]);
    await rows('select issue_eligible_point_tickets($1,$2)',[member,card]);
    const available = () => rows("select ticket_id,reward_id from point_tickets where member_id=$1 and status='available' order by ticket_id",[member]);
    const tickets = await available();
    assert.equal(tickets.length, 3);
    assert.equal(new Set(tickets.map(x => x.ticket_id)).size, 3);
    assert.ok(tickets.every(x => x.reward_id === reward));
    await rows('select issue_eligible_point_tickets($1,$2)',[member,card]);
    assert.equal((await available()).length,3,'repeating the issuer cannot duplicate vouchers');
    await rows('update point_balances set stamps=25 where member_id=$1 and point_card_id=$2',[member,card]);
    await rows('select issue_eligible_point_tickets($1,$2)',[member,card]);
    assert.equal((await available()).length,5,'additional earned points extend the available quantity');
    assert.equal((await rows('select stamps from point_balances where member_id=$1 and point_card_id=$2',[member,card]))[0].stamps,25,'issuing does not deduct points');
  } finally { await db.close(); }
});
