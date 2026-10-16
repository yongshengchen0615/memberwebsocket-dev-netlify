const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('acquire and renewal use the same bounded five-minute TTL and actor-owned RPC', async () => {
  const source = read('supabase/functions/test-control-api/index.ts');
  const start = source.indexOf('const E2E_EXECUTION_LEASE_TTL_MINUTES');
  const end = source.indexOf('async function prepareTestAccountConsents', start);
  const context = { ApiError: Error, UUID_RE: /^[0-9a-f-]{36}$/i, asText: value => String(value || '') };
  vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end)) +
    '\nglobalThis.probe = { acquireE2EExecutionLease, heartbeatE2EExecutionLease };', context);
  const leaseId = '00000000-0000-4000-8000-000000000001', calls = [];
  const supabase = { rpc: async (name, args) => { calls.push({ name, args }); return { data: name.includes('acquire') ? leaseId : false }; } };
  const identity = { lineUserId: 'verified-admin' };
  assert.equal((await context.probe.acquireE2EExecutionLease(supabase, identity)).expiresInMinutes, 5);
  const renewal = await context.probe.heartbeatE2EExecutionLease(supabase, identity, { leaseId, actor: 'untrusted-client' });
  assert.equal(renewal.renewed, false, 'a lost lease must never be presented as renewed');
  assert.equal(renewal.expiresInMinutes, 5);
  for (const { args } of calls) {
    assert.equal(args.p_ttl_minutes, 5);
    assert.equal(args.p_actor, 'verified-admin');
  }
});

test('both purge overloads preserve a valid background lease, reclaim expired leases, and retain service-role access only', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.test_execution_leases(id uuid primary key default gen_random_uuid(), lease_type text,
        actor_line_user_id text, expires_at timestamptz, created_at timestamptz default now());
      create function public.is_qa_test_provenance(text) returns boolean language sql immutable as 'select false';
      create function public.admin_purge_all_test_data(p_keep_history boolean default false) returns jsonb language plpgsql as $$
      begin
        if exists(select 1 from public.test_execution_leases where expires_at > clock_timestamp()) then
          raise exception 'TEST_EXECUTION_ACTIVE';
        end if;
        return '{}'::jsonb;
      end $$;
      create function public.admin_purge_extended_qa_artifacts() returns jsonb language sql as $$ select '{}'::jsonb $$;
      create table public.fixed_ticket_templates(id uuid,created_by text);
      create table public.event_tickets(created_by text,fixed_ticket_template_id uuid);
      ${['point_cards','ticket_templates','calendar_items','booking_services','booking_service_types','booking_technicians']
        .map(name => 'create table public.' + name + '(created_by text);').join('\n')}
    `);
    await db.exec(read('supabase/migrations/20261006044913_e2e_execution_lease_heartbeat.sql'));
    await db.exec(read('supabase/migrations/20261016025009_background_e2e_lease_grace.sql'));
    const lease = (await db.query("select public.admin_acquire_test_execution_lease('verified-admin',5) as id")).rows[0].id;
    await db.query("update public.test_execution_leases set last_heartbeat_at=clock_timestamp()-interval '2 minutes'");
    for (const argument of ['', 'true']) {
      await assert.rejects(db.query('select public.admin_purge_all_test_data_converged(' + argument + ')'), /TEST_EXECUTION_ACTIVE/);
      assert.equal((await db.query('select count(*)::int as n from public.test_execution_leases')).rows[0].n, 1);
    }
    assert.equal((await db.query("select public.admin_heartbeat_test_execution_lease($1,'other-admin',5) as renewed", [lease])).rows[0].renewed, false);
    assert.equal((await db.query("select public.admin_heartbeat_test_execution_lease($1,'verified-admin',5) as renewed", [lease])).rows[0].renewed, true);
    await db.query("update public.test_execution_leases set expires_at=clock_timestamp()-interval '1 second'");
    assert.equal((await db.query("select public.admin_heartbeat_test_execution_lease($1,'verified-admin',5) as renewed", [lease])).rows[0].renewed, false);
    for (const argument of ['', 'true']) await db.query('select public.admin_purge_all_test_data_converged(' + argument + ')');
    assert.equal((await db.query('select count(*)::int as n from public.test_execution_leases')).rows[0].n, 0);
    for (const signature of ['()', '(boolean)']) for (const role of ['anon','authenticated','service_role']) {
      const value = await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed',
        [role, 'public.admin_purge_all_test_data_converged' + signature]);
      assert.equal(value.rows[0].allowed, role === 'service_role');
    }
  } finally { await db.close(); }
});
