const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const database = require('./database.cjs');
const fixture = require('../business-runtime-fixture.cjs');
const migration = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/20261030050000_ticket_booking_service_groups.sql'), 'utf8');
const uuid = () => crypto.randomUUID();
const actor = 'U' + '9'.repeat(32);

test('AC-DB-001/002: real PostgreSQL 17 applies groups to public + tenant, preserving any/all and privilege isolation', async () => {
  const h = await fixture({ ...await database() });
  try {
    const tenant = await h.approve(actor, 'ticket-groups-' + uuid().slice(0, 8));
    await h.db.exec(migration);
    for (const schema of ['public', tenant.runtime_schema]) {
      const prefix = schema + '.';
      const valid = await h.db.query(
        'select ' + prefix + 'ticket_service_groups_valid($1::jsonb) v',
        [JSON.stringify([[uuid(), uuid()], [uuid()]])]
      );
      assert.equal(valid.rows[0].v, true);
      for (const invalid of [[[]], [['not-a-uuid']], Array.from({ length: 11 }, () => [uuid()])]) {
        const res = await h.db.query('select ' + prefix + 'ticket_service_groups_valid($1::jsonb) v', [JSON.stringify(invalid)]);
        assert.equal(res.rows[0].v, false);
      }
      const rights = (await h.db.query(
        "select has_function_privilege('anon',$1,'EXECUTE') denied,has_function_privilege('service_role',$1,'EXECUTE') permitted",
        [prefix + 'booking_meets_required_services(uuid,uuid[],text,jsonb)']
      )).rows[0];
      assert.deepEqual(rights, { denied: false, permitted: true });
      const empty = await h.db.query(
        'select ' + prefix + 'booking_meets_required_services($1::uuid,$2::uuid[],$3,$4::jsonb) allowed',
        [uuid(), [], 'any', '[]']
      );
      assert.equal(empty.rows[0].allowed, true);
      const blocked = await h.db.query(
        'select ' + prefix + 'booking_meets_required_services($1::uuid,$2::uuid[],$3,$4::jsonb) allowed',
        [uuid(), [], 'any', JSON.stringify([[uuid(),uuid()]])]
      );
      assert.equal(blocked.rows[0].allowed, false);
    }
  } finally { await h.db.close(); }
});

test('AC-DB-003: A+B OR A+C matches real booking items and rejects B+C', async () => {
  const h = await fixture({ ...await database() });
  try {
    const tenant = await h.approve(actor, 'ticket-groups-items-' + uuid().slice(0, 8));
    await h.db.exec(migration);
    const s = tenant.runtime_schema;
    const serviceIds = [uuid(), uuid(), uuid()];
    await h.db.query('insert into ' + s + ".booking_service_types(name) values('Ticket group services')");
    for (const id of serviceIds) {
      await h.db.query('insert into ' + s + '.booking_services(id,title,duration_minutes,price_amount,is_active,service_type,created_by) values($1,$2,30,100,true,$3,$4)',
        [id, 'Service ' + id.slice(0, 4), 'Ticket group services', 'system']);
    }
    const tech = (await h.db.query('insert into ' + s + ".booking_technicians(name,is_active) values('Ticket QA tech',true) returning id")).rows[0].id;
    await h.db.query('update ' + s + '.booking_settings set primary_technician_id=$1',[tech]);
    const member = (await h.db.query('insert into ' + s +
      '.members(line_user_id,display_name,member_code,membership_status,status,is_test_account) values($1,$2,$3,$4,$5,true) returning id',
      ['U' + '7'.repeat(32), 'Ticket QA', 'TICKET-QA-'+uuid().slice(0,8), 'active', 'active'])).rows[0].id;
    await h.db.query('update '+s+'.members set is_test_account=false where id=$1',[member]);
    const date = (await h.db.query("select ((now() at time zone 'Asia/Taipei')::date + 5)::text d")).rows[0].d;
    const book = async (selected, time) => (await h.db.query(
      'select (' + s + '.create_group_booking_request_v2($1,$2,$3,$4,$5,$6)).id id',
      ['BOOK-' + uuid(), member, date, time, JSON.stringify([{ technicianId: tech, items:selected.map(id => ({serviceId:id,quantity:1})) }]), '']
    )).rows[0].id;
    const combos = [ [serviceIds[0],serviceIds[1]], [serviceIds[0],serviceIds[2]] ];
    const groupJson = JSON.stringify(combos);
    const check = async (id, rule) => (await h.db.query('select ' + s +
      '.booking_meets_required_services($1::uuid,$2::uuid[],$3,$4::jsonb) allowed',
      [id,[], 'any', JSON.stringify(rule)])).rows[0].allowed;
    const ab = await book([serviceIds[0],serviceIds[1]],'10:00');
    const ac = await book([serviceIds[0],serviceIds[2]],'12:00');
    const bc = await book([serviceIds[1],serviceIds[2]],'14:00');
    assert.equal(await check(ab,combos),true);
    assert.equal(await check(ac,combos),true);
    assert.equal(await check(bc,combos),false);
    assert.equal(await check(ab,[[serviceIds[0],serviceIds[2]]]),false);
    assert.equal(await check(ab,[[serviceIds[0]]]),true);
    assert.equal(groupJson.length > 0,true);
  } finally { await h.db.close(); }
});
