const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261009180000_recycle_e2e_runtime_before_run.sql'), 'utf8');

test('SQL compiles, disallows anonymous callers and rejects a missing execution lease', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create table public.test_execution_leases (
        id uuid primary key, lease_type text not null, actor_line_user_id text not null,
        expires_at timestamptz not null, created_at timestamptz default now()
      );
    `);
    await db.exec(migration);
    const result = await db.query("select has_function_privilege('anon', 'public.admin_recycle_e2e_runtime(uuid,text)', 'execute') as allowed");
    assert.equal(result.rows[0].allowed, false);
    await assert.rejects(
      db.query("select public.admin_recycle_e2e_runtime('00000000-0000-4000-8000-000000000001'::uuid, 'not-an-admin')"),
      /E2E_RECYCLE_LEASE_INVALID/
    );
  } finally {
    await db.close();
  }
});
