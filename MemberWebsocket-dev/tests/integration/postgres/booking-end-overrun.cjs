'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const database = require('./database.cjs');
const fixture = require('../business-runtime-fixture.cjs');

const migrationFile = name => fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/' + name), 'utf8');
const phone = migrationFile('20261107093000_booking_phone_fallback.sql');
const oldPolicy = migrationFile('20261108173000_booking_allow_end_overrun.sql');
const numericPolicy = migrationFile('20261108210000_booking_end_overrun_minutes.sql');
const id = n => 'U' + String(n).repeat(32);
const signature='(time without time zone,time without time zone,integer,integer,integer,text,integer,boolean,time without time zone,timestamp with time zone,text,boolean,boolean,jsonb,text,integer)';
const casts=['time','time','integer','integer','integer','text','integer','boolean','time','timestamptz','text','boolean','boolean','jsonb','text','integer'];
const slotSql = schema => `select ${schema}.booking_slot_fits($1::date,$2::time,$3::integer,$4::time,$5::time,$6::integer) ok`;
const slotArgs = (time, duration, open='09:00', close='19:00') => ['2026-12-31',time,duration,open,close,30];

test('AC-MIN-001..008: schema upgrade, numeric guard, tenant isolation, auth, audit and future provisioning',async()=>{
  const h = await fixture({...await database()});
  try{
    const first=await h.approve(id(5),'overrun-minutes-a-'+crypto.randomUUID().slice(0,6));
    const second=await h.approve(id(6),'overrun-minutes-b-'+crypto.randomUUID().slice(0,6));
    const a=first.runtime_schema,b=second.runtime_schema;
    assert.notEqual(a,b);
    // Match real schema upgrade order on an isolated PG17 template.
    await h.db.exec(phone);
    await h.db.exec(oldPolicy);
    await h.db.query(`update ${a}.booking_settings set allow_end_overrun=true where id=1`);
    await h.db.exec(numericPolicy);

    for(const schema of ['public',a,b]){
      const column=(await h.db.query(`select column_default,is_nullable from information_schema.columns where table_schema=$1 and table_name='booking_settings' and column_name='max_end_overrun_minutes'`,[schema])).rows[0];
      assert.equal(column.is_nullable,'NO');
      assert.match(column.column_default,/0/);
      const rights=(await h.db.query(`select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') member,has_function_privilege('service_role',$1,'execute') service`,[schema+'.save_booking_shared_settings_v10'+signature])).rows[0];
      assert.deepEqual(rights,{anon:false,member:false,service:true},schema+' settings require service role');
      assert.equal((await h.db.query('select p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2',[schema,'booking_slot_fits'])).rows[0].provolatile,'s');
    }
    assert.equal((await h.db.query(`select max_end_overrun_minutes from ${a}.booking_settings where id=1`)).rows[0].max_end_overrun_minutes,1439,'old enabled shop keeps existing late-ending access on upgrade');
    assert.equal((await h.db.query(`select max_end_overrun_minutes from ${b}.booking_settings where id=1`)).rows[0].max_end_overrun_minutes,0,'old disabled shop stays strict');
    assert.equal((await h.db.query(slotSql(a),slotArgs('18:30',60))).rows[0].ok,true);
    assert.equal((await h.db.query(slotSql(b),slotArgs('18:30',60))).rows[0].ok,false);

    const current=(await h.db.query(`select * from ${a}.booking_settings where id=1`)).rows[0];
    const args=[
      '09:00','19:00',30,current.min_advance_days,current.max_advance_days,
      current.booking_notice,10,current.reminder_enabled,current.reminder_time,
      current.updated_at,id(5),current.snapshot_location_required,
      current.ticket_booking_required,JSON.stringify(current.snapshot_locations||[]),
      current.phone_booking_number,30
    ];
    const sql=`select (${a}.save_booking_shared_settings_v10(${casts.map((cast,i)=>'$'+(i+1)+'::'+cast).join(',')})).max_end_overrun_minutes minutes`;
    assert.equal((await h.db.query(sql,args)).rows[0].minutes,30);
    assert.equal((await h.db.query(slotSql(a),slotArgs('18:30',60))).rows[0].ok,true,'exactly +30 allowed');
    assert.equal((await h.db.query(slotSql(a),slotArgs('18:30',61))).rows[0].ok,false,'+31 denied');
    assert.equal((await h.db.query(slotSql(a),slotArgs('18:00',90))).rows[0].ok,true,'exact bound from earlier start');
    assert.equal((await h.db.query(slotSql(a),slotArgs('18:30',90))).rows[0].ok,false,'+60 denied');
    assert.equal((await h.db.query(slotSql(a),slotArgs('19:00',30))).rows[0].ok,false,'start at close forbidden');
    assert.equal((await h.db.query(slotSql(a),slotArgs('08:30',30))).rows[0].ok,false,'before open forbidden');
    assert.equal((await h.db.query(slotSql(a),slotArgs('18:45',60))).rows[0].ok,false,'interval alignment retained');
    assert.equal((await h.db.query(slotSql(a),slotArgs('09:00',1440))).rows[0].ok,false,'duration storage cap retained');
    assert.equal((await h.db.query(slotSql(b),slotArgs('18:30',60))).rows[0].ok,false,'merchant B isolated');

    await assert.rejects(h.db.query(sql,args),/BOOKING_SETTINGS_CONFLICT/,'stale draft cannot overwrite minutes');
    let latest=(await h.db.query(`select * from ${a}.booking_settings where id=1`)).rows[0];
    const forbidden=[...args];forbidden[9]=latest.updated_at;forbidden[10]=id(9);
    await assert.rejects(h.db.query(sql,forbidden),/ADMIN_REQUIRED/,'non-admin cannot update limit');
    const invalid=[...args];invalid[9]=latest.updated_at;invalid[15]=1440;
    await assert.rejects(h.db.query(sql,invalid),/INVALID_BOOKING_END_OVERRUN_MINUTES/);
    invalid[15]=-1;
    await assert.rejects(h.db.query(sql,invalid),/INVALID_BOOKING_END_OVERRUN_MINUTES/);
    assert.equal((await h.db.query(`select max_end_overrun_minutes from ${a}.booking_settings where id=1`)).rows[0].max_end_overrun_minutes,30);

    // v9 still exists but its boolean cannot silently change the authoritative limit.
    const v9casts=[...casts.slice(0,15),'boolean'];
    const legacySql=`select (${a}.save_booking_shared_settings_v9(${v9casts.map((cast,i)=>'$'+(i+1)+'::'+cast).join(',')})).max_end_overrun_minutes minutes`;
    const legacyArgs=[...args.slice(0,15),true];legacyArgs[9]=latest.updated_at;
    assert.equal((await h.db.query(legacySql,legacyArgs)).rows[0].minutes,30);
    latest=(await h.db.query(`select * from ${a}.booking_settings where id=1`)).rows[0];
    const overnight=[...args];overnight[9]=latest.updated_at;overnight[15]=60;
    assert.equal((await h.db.query(sql,overnight)).rows[0].minutes,60);
    assert.equal((await h.db.query(slotSql(a),slotArgs('01:30',90,'14:00','02:00'))).rows[0].ok,true,'overnight +60');
    assert.equal((await h.db.query(slotSql(a),slotArgs('02:00',30,'14:00','02:00'))).rows[0].ok,false,'overnight starts after closing forbidden');
    assert.equal((await h.db.query(slotSql(a),slotArgs('23:00',120,'23:30','23:25'))).rows[0].ok,false,'two-day timestamp guard retained');
    latest=(await h.db.query(`select * from ${a}.booking_settings where id=1`)).rows[0];
    const off=[...args];off[9]=latest.updated_at;off[15]=0;
    assert.equal((await h.db.query(sql,off)).rows[0].minutes,0);
    assert.equal((await h.db.query(slotSql(a),slotArgs('18:30',60))).rows[0].ok,false,'0 disallows all late finish');
    assert.equal((await h.db.query(`select allow_end_overrun from ${a}.booking_settings where id=1`)).rows[0].allow_end_overrun,false,'legacy bool synchronized');
    assert.equal((await h.db.query(`select count(*)::integer n from ${a}.booking_audit_events where action='BOOKING_END_OVERRUN_MINUTES_UPDATED'`)).rows[0].n,3,'30,60,0 transitions audited');

    const third=await h.approve(id(7),'overrun-minutes-c-'+crypto.randomUUID().slice(0,6));
    const c=third.runtime_schema;
    assert.equal((await h.db.query(`select max_end_overrun_minutes from ${c}.booking_settings where id=1`)).rows[0].max_end_overrun_minutes,0);
    assert.ok((await h.db.query('select to_regprocedure($1) fn',[c+'.save_booking_shared_settings_v10'+signature])).rows[0].fn,'future tenant receives v10');
    const restored=await h.db.backupRestore();
    assert.equal((await restored.client.query(`select max_end_overrun_minutes from ${a}.booking_settings where id=1`)).rows[0].max_end_overrun_minutes,0);
    assert.equal((await restored.client.query(`select max_end_overrun_minutes from ${b}.booking_settings where id=1`)).rows[0].max_end_overrun_minutes,0);
  }finally{await h.db.close();}
});
