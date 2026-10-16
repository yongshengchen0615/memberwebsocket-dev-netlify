const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migrations = path.join(__dirname, '../../supabase/migrations');
const read = name => fs.readFileSync(path.join(migrations, name), 'utf8');
const fix = fs.readdirSync(migrations).find(name => name.endsWith('_test_account_phone_contract.sql'));

test('test account creation obeys the live member phone contract and preserves maintenance controls', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create sequence public.test_member_sequence;
      create table public.members (
        id uuid primary key default gen_random_uuid(), line_user_id text unique not null,
        display_name text, member_code text unique, status text, membership_status text,
        birthday date, phone text, joined_at timestamptz, last_login_at timestamptz,
        surname text, salutation text, is_test_account boolean default false,
        test_account_sequence bigint unique, created_at timestamptz, updated_at timestamptz
      );
      create table public.test_mode_settings (
        id boolean primary key, enabled boolean, allow_admin_user_login boolean,
        maintenance_enabled boolean, allow_pc_test_login boolean, allow_mobile_test_login boolean,
        maintenance_message text, updated_by text, updated_at timestamptz
      );
      insert into public.test_mode_settings values (true,true,true,false,false,false,'before','admin',now());
      create table public.test_login_sessions (
        id text primary key, device_class text, revoked_at timestamptz, last_used_at timestamptz
      );
      insert into public.test_login_sessions values ('old-pc','pc',null,now()),('old-mobile','mobile',null,now());
      create table public.member_presence_sessions (
        id text primary key, last_seen_at timestamptz, offline_at timestamptz,
        offline_reason text, updated_at timestamptz
      );
      insert into public.member_presence_sessions values ('online',now(),null,null,now());
      grant all on public.members, public.test_mode_settings, public.test_login_sessions,
        public.member_presence_sessions to service_role;
      grant usage,select on public.test_member_sequence to service_role;
    `);
    // Load the actual production constraints and the previously deployed generator.
    for (const name of [
      '20261003152500_member_phone_e164_and_pending_booking_notice.sql',
      '20261003160000_phone_quality_and_member_sent_booking_chat.sql',
    ]) {
      const sql = read(name);
      await db.exec(sql.slice(0, sql.indexOf('CREATE OR REPLACE FUNCTION')));
    }
    await db.exec(read('20260930124711_maintenance_global_revocation_boundary.sql'));
    const save = (maintenance, pc, mobile, count = 0) => db.query(
      'select * from public.admin_save_maintenance_test_access($1,$2,$3,$4,$5,$6)',
      [maintenance, pc, mobile, 'test maintenance', 'admin', count],
    );
    await assert.rejects(save(true, true, true, 1), /members_phone_(e164|quality)_check/);
    assert.equal((await db.query('select maintenance_enabled from test_mode_settings')).rows[0].maintenance_enabled, false,
      'a failed account insert must roll back the settings update');
    assert.equal((await db.query('select count(*)::int n from test_login_sessions where revoked_at is null')).rows[0].n, 2);

    await db.exec(read(fix));
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(save(true, true, true, 1), /permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    const first = await save(true, true, true, 50);
    assert.deepEqual(first.rows, [{ created_account_count: 50, total_test_accounts: 50 }]);
    const boundary = (await db.query('select maintenance_revoked_after from test_mode_settings')).rows[0].maintenance_revoked_after;
    assert.ok(boundary);
    assert.equal((await db.query('select count(*)::int n from test_login_sessions where revoked_at is null')).rows[0].n, 0);
    assert.equal((await db.query('select offline_reason from member_presence_sessions')).rows[0].offline_reason, 'maintenance');

    await db.exec("insert into test_login_sessions values ('new-pc','pc',null,now()),('new-mobile','mobile',null,now())");
    await save(true, true, false);
    assert.deepEqual((await db.query('select maintenance_revoked_after from test_mode_settings')).rows[0].maintenance_revoked_after, boundary);
    assert.deepEqual((await db.query('select id from test_login_sessions where revoked_at is null')).rows.map(row => row.id), ['new-pc']);
    for (let i = 0; i < 3; i++) await save(true, true, true, 50);
    const phones = (await db.query('select phone from members where is_test_account')).rows.map(row => row.phone);
    assert.equal(phones.length, 200);
    assert.equal(new Set(phones).size, 200);
    for (const phone of phones) {
      assert.match(phone, /^\+8869\d{8}$/);
      assert.doesNotMatch(phone, /(\d)\1{6,}/);
    }
    await assert.rejects(save(true, true, true, 1), /TEST_ACCOUNT_LIMIT_REACHED/);
    await assert.rejects(save(true, true, true, 51), /INVALID_TEST_ACCOUNT_COUNT/);
    await save(false, true, true);
    assert.equal((await db.query('select count(*)::int n from test_login_sessions where revoked_at is null')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int n from members')).rows[0].n, 200);
  } finally { await db.close(); }
});
