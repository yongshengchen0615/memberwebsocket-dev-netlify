'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const database = require('./database.cjs');
const fixture = require('../business-runtime-fixture.cjs');

const migration = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/20261108173000_booking_allow_end_overrun.sql'), 'utf8');
const id = n => 'U' + String(n).repeat(32);
const signature = '(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text,boolean)';
const casts = [
  'time', 'time', 'integer', 'integer', 'integer', 'text', 'integer',
  'boolean', 'time', 'timestamptz', 'text', 'boolean', 'boolean', 'jsonb',
  'text', 'boolean'
];
const slot = (schema, time, minutes, open = '09:00', close = '19:00', date = '2026-12-31') =>
  `select ${schema}.booking_slot_fits($1::date,$2::time,$3::integer,$4::time,$5::time,$6::integer) ok`;
const slotArgs = (time, minutes, open = '09:00', close = '19:00', date = '2026-12-31') =>
  [date, time, minutes, open, close, 30];

test('AC-001..006: tenant upgrade, secure admin toggle, close boundary and future shop provisioning', async () => {
  const h = await fixture({ ...await database() });
  try {
    const first = await h.approve(id(5), 'end-overrun-a-' + crypto.randomUUID().slice(0, 6));
    const second = await h.approve(id(6), 'end-overrun-b-' + crypto.randomUUID().slice(0, 6));
    const a = first.runtime_schema, b = second.runtime_schema;
    assert.notEqual(a, b);
    await h.db.exec(migration);

    for (const schema of ['public', a, b]) {
      const row = (await h.db.query(`select column_default,is_nullable from information_schema.columns where table_schema=$1 and table_name='booking_settings' and column_name='allow_end_overrun'`,[schema])).rows[0];
      assert.equal(row.is_nullable,'NO');
      assert.match(row.column_default,/false/);
      const rights = (await h.db.query(`select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') member,has_function_privilege('service_role',$1,'execute') service`,[schema+'.save_booking_shared_settings_v9'+signature])).rows[0];
      assert.deepEqual(rights,{anon:false,member:false,service:true},schema+' v9 settings must be service-only');
      const volatility = (await h.db.query('select p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2',[schema,'booking_slot_fits'])).rows[0].provolatile;
      assert.equal(volatility,'s',schema+' setting-dependent slot predicate must be STABLE');
      assert.equal((await h.db.query(`select allow_end_overrun from ${schema}.booking_settings where id=1`)).rows[0].allow_end_overrun,false);
      assert.equal((await h.db.query(slot(schema),slotArgs('18:30',60))).rows[0].ok,false,schema+' default denies late finish');
    }

    const current = (await h.db.query(`select * from ${a}.booking_settings where id=1`)).rows[0];
    const args = [
      '09:00','19:00',30,current.min_advance_days,current.max_advance_days,
      current.booking_notice,10,current.reminder_enabled,current.reminder_time,
      current.updated_at,id(5),current.snapshot_location_required,
      current.ticket_booking_required,JSON.stringify(current.snapshot_locations||[]),
      current.phone_booking_number,true
    ];
    const sql = `select (${a}.save_booking_shared_settings_v9(${casts.map((c,i)=>'$'+(i+1)+'::'+c).join(',')})).allow_end_overrun enabled`;
    const saved = (await h.db.query(sql,args)).rows[0];
    assert.equal(saved.enabled,true,'admin can enable overrun');
    assert.equal((await h.db.query(slot(a),slotArgs('18:30',60))).rows[0].ok,true,'18:30–19:30 is valid');
    assert.equal((await h.db.query(slot(a),slotArgs('19:00',30))).rows[0].ok,false,'closing time cannot be a start');
    assert.equal((await h.db.query(slot(a),slotArgs('08:30',30))).rows[0].ok,false,'before opening cannot be a start');
    assert.equal((await h.db.query(slot(a),slotArgs('18:45',60))).rows[0].ok,false,'slot alignment still enforced');
    assert.equal((await h.db.query(slot(a),slotArgs('18:30',1440))).rows[0].ok,false,'existing duration cap still applies');
    assert.equal((await h.db.query(slot(a),slotArgs('01:30',90,'14:00','02:00'))).rows[0].ok,true,'overnight business date rollover');
    assert.equal((await h.db.query(slot(a),slotArgs('02:00',30,'14:00','02:00'))).rows[0].ok,false,'overnight closing start denied');
    assert.equal((await h.db.query(slot(b),slotArgs('18:30',60))).rows[0].ok,false,'merchant B stays disabled');

    await assert.rejects(h.db.query(sql,args),/BOOKING_SETTINGS_CONFLICT/,'stale version cannot overwrite policy');
    const latest = (await h.db.query(`select * from ${a}.booking_settings where id=1`)).rows[0];
    const badActor = [...args]; badActor[9] = latest.updated_at; badActor[10] = id(9);
    await assert.rejects(h.db.query(sql,badActor),/ADMIN_REQUIRED/,'non-admin cannot enable late ending');
    assert.equal((await h.db.query(`select allow_end_overrun from ${a}.booking_settings where id=1`)).rows[0].allow_end_overrun,true);

    // A legacy v8 caller must retain the new setting rather than silently resetting it.
    const legacySql = `select (${a}.save_booking_shared_settings_v8(${casts.slice(0,15).map((c,i)=>'$'+(i+1)+'::'+c).join(',')})).allow_end_overrun enabled`;
    const legacyArgs = [...args.slice(0,15)]; legacyArgs[9] = latest.updated_at;
    assert.equal((await h.db.query(legacySql,legacyArgs)).rows[0].enabled,true);
    const again = (await h.db.query(`select updated_at from ${a}.booking_settings where id=1`)).rows[0];
    const disabledArgs=[...args];disabledArgs[9]=again.updated_at;disabledArgs[15]=false;
    assert.equal((await h.db.query(sql,disabledArgs)).rows[0].enabled,false);
    assert.equal((await h.db.query(slot(a),slotArgs('18:30',60))).rows[0].ok,false,'switch-off restores strict close');
    const audit=(await h.db.query(`select count(*)::int n from ${a}.booking_audit_events where action='BOOKING_END_OVERRUN_POLICY_UPDATED'`)).rows[0].n;
    assert.equal(audit,2,'both transitions audited exactly once');

    const third=await h.approve(id(7),'end-overrun-c-'+crypto.randomUUID().slice(0,6));
    const c=third.runtime_schema;
    assert.equal((await h.db.query(`select allow_end_overrun from ${c}.booking_settings where id=1`)).rows[0].allow_end_overrun,false);
    assert.ok((await h.db.query('select to_regprocedure($1) fn',[c+'.save_booking_shared_settings_v9'+signature])).rows[0].fn,'new merchants receive settings RPC');
    const restored=await h.db.backupRestore();
    assert.equal((await restored.client.query(`select allow_end_overrun from ${a}.booking_settings where id=1`)).rows[0].allow_end_overrun,false);
    assert.equal((await restored.client.query(`select allow_end_overrun from ${b}.booking_settings where id=1`)).rows[0].allow_end_overrun,false);
  } finally { await h.db.close(); }
});
