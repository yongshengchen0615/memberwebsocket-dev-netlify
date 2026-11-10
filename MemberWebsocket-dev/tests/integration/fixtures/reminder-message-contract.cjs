const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async (db, { rolesCreated = false } = {}) => {
  const dir = path.resolve(__dirname, '../../../supabase/migrations');
  const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
  const repair = read(fs.readdirSync(dir).find(name => name.endsWith('_repair_business_reminder_message_contract.sql')));
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  const existing = 'business_' + 'a'.repeat(32);
  const customized = 'business_' + 'b'.repeat(32);
  const fresh = 'business_' + 'c'.repeat(32);
  const reverted = 'business_' + 'd'.repeat(32);
  await db.exec(`${rolesCreated ? '' : 'create role anon; create role authenticated; create role service_role;'}
    create schema platform_private; create schema booking_notifications;
    create table platform_private.tenants(runtime_schema text);
    create table public.booking_settings(id integer primary key);
    create function booking_notifications.sync_day_before_reminders() returns void language sql as $$select$$;
    create function public.skip_invalid_booking_reminder(uuid,integer) returns boolean language sql as $$select false$$;`);
  // Execute the production installer, excluding the unrelated scheduling setup.
  await db.exec(read('20261031095500_business_booking_reminder_rollout.sql').split('-- Upgrade existing tenants.')[0]);
  await db.exec(read('20261102210000_booking_reminder_message_template.sql'));
  const addTenant = async schema => db.exec(`create schema ${schema};
    create table ${schema}.bookings(id uuid,reminder_enabled boolean,reminder_time time);
    create table ${schema}.booking_settings(id integer primary key,updated_at timestamptz default '2026-01-01T00:00:00Z');
    create table ${schema}.notice_outbox(id uuid);
    create table ${schema}.notice_config(id boolean);
    insert into ${schema}.booking_settings(id) values(1);
    insert into platform_private.tenants values('${schema}');`);
  await addTenant(existing);
  await addTenant(customized);
  await db.exec(`alter table ${customized}.booking_settings add column reminder_message text not null default 'Custom';`);
  const before = await one(`select to_jsonb(s) row from ${existing}.booking_settings s`);
  await db.exec(repair);
  assert.equal((await one(`select to_jsonb(s)-'reminder_message' row from ${existing}.booking_settings s`)).row.id, before.row.id);
  assert.deepEqual((await one(`select to_jsonb(s)-'reminder_message' row from ${existing}.booking_settings s`)).row, before.row);
  assert.equal((await one(`select reminder_message from ${customized}.booking_settings`)).reminder_message, 'Custom');
  await addTenant(fresh);
  await db.query('select platform_private.install_booking_reminder($1)', [fresh]);
  for (const schema of [existing, fresh]) {
    assert.equal((await one(`select reminder_message from ${schema}.booking_settings`)).reminder_message, '請準時到場；如需調整請至預約頁操作。');
    await db.query(`update ${schema}.booking_settings set reminder_message=$1`, ['A 店\n請準時到場']);
    for (const message of ['', 'x'.repeat(401)])
      await assert.rejects(db.query(`update ${schema}.booking_settings set reminder_message=$1`, [message]), /booking_reminder_message_length_check/);
    await db.query(`update ${schema}.booking_settings set reminder_message=$1`, ['x'.repeat(400)]);
    assert.equal((await one(`select is_nullable from information_schema.columns where table_schema=$1 and table_name='booking_settings' and column_name='reminder_message'`, [schema])).is_nullable, 'NO');
  }
  const definition = (await one("select pg_get_functiondef('platform_private.install_booking_reminder(text)'::regprocedure) value")).value;
  await db.exec(repair);
  await db.query('select platform_private.install_booking_reminder($1)', [fresh]);
  assert.equal((await one("select pg_get_functiondef('platform_private.install_booking_reminder(text)'::regprocedure) value")).value, definition);
  assert.equal((await one(`select reminder_message from ${fresh}.booking_settings`)).reminder_message, 'x'.repeat(400));
  assert.equal((await one(`select reminder_message from ${customized}.booking_settings`)).reminder_message, 'Custom');
  await addTenant(reverted);
  await db.exec('begin');
  await db.query('select platform_private.install_booking_reminder_message($1)', [reverted]);
  await db.exec('rollback');
  assert.equal((await one("select count(*)::int n from information_schema.columns where table_schema=$1 and column_name='reminder_message'", [reverted])).n, 0);
  for (const schema of ['public', 'business_' + 'e'.repeat(32), null])
    await assert.rejects(db.query('select platform_private.install_booking_reminder_message($1)', [schema]), /BUSINESS_SCHEMA_INVALID/);
  for (const role of ['anon', 'authenticated']) {
    for (const name of ['install_booking_reminder', 'install_booking_reminder_message'])
      assert.equal((await one('select has_function_privilege($1,$2,\'execute\') allowed', [role, `platform_private.${name}(text)`])).allowed, false);
    assert.equal((await one('select has_table_privilege($1,$2,\'update\') allowed', [role, fresh+'.booking_settings'])).allowed, false);
  }
};
