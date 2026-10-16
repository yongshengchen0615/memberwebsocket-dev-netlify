const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = fs.readFileSync(
  path.join(__dirname, '../../supabase/migrations/20261008083358_test_account_duplicate_login_setting.sql'),
  'utf8',
);
const takeoverMigration = fs.readFileSync(
  path.join(__dirname, '../../supabase/migrations/20261008091007_test_login_takeover_single_session.sql'),
  'utf8',
);

test('new virtual test login always revokes existing same-surface sessions', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE TABLE public.members (
        id uuid PRIMARY KEY, is_test_account boolean NOT NULL,
        status text NOT NULL, membership_status text NOT NULL
      );
      CREATE TABLE public.test_mode_settings (
        id boolean PRIMARY KEY, maintenance_enabled boolean NOT NULL DEFAULT false,
        allow_pc_test_login boolean NOT NULL DEFAULT false,
        allow_mobile_test_login boolean NOT NULL DEFAULT false
      );
      INSERT INTO public.test_mode_settings
        (id,maintenance_enabled,allow_pc_test_login,allow_mobile_test_login)
        VALUES (true,true,true,true);
      CREATE TABLE public.test_login_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash text NOT NULL UNIQUE,
        member_id uuid NOT NULL REFERENCES public.members(id),
        surface text NOT NULL, device_class text NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.realtime_events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        scope text NOT NULL, event_type text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.member_presence_sessions (
        member_id uuid NOT NULL REFERENCES public.members(id),
        surface text NOT NULL, offline_at timestamptz,
        last_seen_at timestamptz NOT NULL,
        offline_reason text, updated_at timestamptz
      );
      CREATE OR REPLACE FUNCTION public.admin_save_maintenance_test_access(
        p_maintenance_enabled boolean, p_allow_pc_test_login boolean,
        p_allow_mobile_test_login boolean, p_maintenance_message text,
        p_updated_by text, p_add_account_count integer DEFAULT 0
      ) RETURNS TABLE(created_account_count integer,total_test_accounts integer)
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF p_add_account_count < 0 OR p_add_account_count > 50 THEN
          RAISE EXCEPTION 'INVALID_TEST_ACCOUNT_COUNT';
        END IF;
        UPDATE public.test_mode_settings
           SET maintenance_enabled=p_maintenance_enabled,
               allow_pc_test_login=p_allow_pc_test_login,
               allow_mobile_test_login=p_allow_mobile_test_login
         WHERE id=true;
        RETURN QUERY SELECT 0,2;
      END;
      $fn$;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;
    `);
    await db.exec(migration);
    await db.exec(takeoverMigration);
    const members = {
      test: '11111111-1111-4111-8111-111111111111',
      formal: '22222222-2222-4222-8222-222222222222',
    };
    await db.query(`
      INSERT INTO public.members(id,is_test_account,status,membership_status)
      VALUES ($1,true,'active','active'),($2,false,'active','active')
    `, [members.test, members.formal]);

    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const login = (token, memberId = members.test, surface = 'member') => db.query(
      'SELECT public.create_test_login_session_v3($1,$2,$3,$4,$5) id',
      [token.repeat(64), memberId, surface, 'pc', expires],
    );
    const save = (allowDuplicate, maintenance = true, count = 0) => db.query(
      'SELECT * FROM public.admin_save_maintenance_test_access_v2($1,$2,$3,$4,$5,$6,$7)',
      [maintenance, true, true, 'maintenance', 'admin', count, allowDuplicate],
    );
    const sessions = () => db.query(`
      SELECT token_hash,revoked_at,revoked_reason FROM public.test_login_sessions
       WHERE member_id=$1 AND surface='member' ORDER BY created_at,id
    `, [members.test]);

    // Defaults fail closed; existing same-surface session blocks another claim.
    assert.equal((await db.query('SELECT allow_duplicate_test_login FROM public.test_mode_settings')).rows[0].allow_duplicate_test_login, false);
    await login('a');
    await assert.rejects(login('b'), /TEST_SURFACE_ALREADY_ACTIVE/);
    assert.equal((await sessions()).rows.length, 1);

    // The legacy toggle enables takeover, not coexistence.
    await save(true);
    await db.query(
      "INSERT INTO public.member_presence_sessions(member_id,surface,last_seen_at) VALUES ($1,'member',now())",
      [members.test],
    );
    await login('b');
    let current = (await sessions()).rows;
    assert.equal(current.filter(row => row.revoked_at === null).length, 1);
    assert.equal(current.find(row => row.revoked_at === null).token_hash, 'b'.repeat(64));
    assert.equal(current.find(row => row.token_hash === 'a'.repeat(64)).revoked_reason, 'replaced_by_new_login');
    const oldPresence = await db.query("SELECT offline_at, offline_reason FROM public.member_presence_sessions WHERE member_id=$1", [members.test]);
    assert.ok(oldPresence.rows[0].offline_at);
    assert.equal(oldPresence.rows[0].offline_reason, 'replaced_by_new_login');
    const eventCount = await db.query("SELECT count(*)::int AS n FROM public.realtime_events WHERE event_type='test_mode.session.started'");
    assert.equal(eventCount.rows[0].n, 2);
    await login('c');
    current = (await sessions()).rows;
    assert.equal(current.filter(row => row.revoked_at === null).length, 1);
    assert.equal(current.find(row => row.token_hash === 'b'.repeat(64)).revoked_reason, 'replaced_by_new_login');
    // Cross-surface tests do not depend on the same-surface policy.
    await login('d', members.test, 'points');
    await assert.rejects(login('e', members.formal), /TEST_ACCOUNT_UNAVAILABLE/);

    // Switching OFF preserves exactly the newest session and blocks a second login.
    await save(false);
    const after = (await sessions()).rows;
    assert.equal(after.filter(row => row.revoked_at === null).length, 1);
    assert.equal(after.find(row => row.revoked_at === null).token_hash, 'c'.repeat(64));
    await assert.rejects(login('f'), /TEST_SURFACE_ALREADY_ACTIVE/);

    // Failed save must atomically roll back both the old and new settings.
    await assert.rejects(save(true, true, 51), /INVALID_TEST_ACCOUNT_COUNT/);
    assert.equal((await db.query('SELECT allow_duplicate_test_login FROM public.test_mode_settings')).rows[0].allow_duplicate_test_login, false);

    // Client roles cannot invoke either privileged session-creation or admin-save RPC.
    for (const role of ['anon','authenticated']) {
      await db.exec('SET ROLE ' + role);
      await assert.rejects(login('g'), /permission denied/);
      await assert.rejects(save(true), /permission denied/);
      await db.exec('RESET ROLE');
    }

    // Even an approved test member cannot login outside maintenance.
    await save(true, false);
    await assert.rejects(login('h'), /TEST_LOGIN_DISABLED/);
  } finally {
    await db.close();
  }
});
