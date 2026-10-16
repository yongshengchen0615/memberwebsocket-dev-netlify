const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('full E2E execution lease is short-lived and heartbeat-renewed', () => {
  const migration = read('supabase/migrations/20261006044913_e2e_execution_lease_heartbeat.sql');
  const api = read('supabase/functions/test-control-api/index.ts');
  const runner = read('admin/e2e-control.js');

  assert.match(migration, /last_heartbeat_at timestamptz not null default clock_timestamp\(\)/);
  assert.match(migration, /admin_heartbeat_test_execution_lease/);
  assert.match(migration, /p_ttl_minutes integer default 1/);
  assert.match(migration, /expires_at = clock_timestamp\(\) \+ make_interval\(mins => v_ttl\)/);
  assert.match(migration, /revoke all on function public\.admin_heartbeat_test_execution_lease/);
  assert.match(migration, /grant execute on function public\.admin_heartbeat_test_execution_lease[\s\S]*to service_role/);

  assert.match(api, /E2E_EXECUTION_LEASE_TTL_MINUTES = 5/);
  assert.match(api, /p_ttl_minutes: E2E_EXECUTION_LEASE_TTL_MINUTES/);
  assert.match(api, /admin\.test-control\.heartbeat-e2e-lease/);
  assert.match(api, /E2E_LEASE_HEARTBEAT_FAILED/);

  assert.match(runner, /const E2E_LEASE_HEARTBEAT_MS = 15000/);
  assert.match(runner, /const E2E_LEASE_HEARTBEAT_FAILURE_LIMIT = 2/);
  assert.match(runner, /heartbeatE2ECleanupLease/);
  assert.match(runner, /window\.setInterval\(\(\) => \{ renewCleanupLease\(\)\.catch/);
  assert.match(runner, /requestStop\(\)/);
  assert.match(runner, /window\.clearInterval\(cleanupLeaseHeartbeatTimer\)/);
  assert.match(runner, /releaseE2ECleanupLease\(leaseToRelease\)/);
});

test('purge keeps the execution safety boundary while expired and stale leases can be reclaimed', () => {
  const purge = read('supabase/migrations/20261005174200_fix_test_purge_evolution_delete_guard.sql');
  const staleRecovery = read('supabase/migrations/20261006045939_reclaim_stale_e2e_leases_before_purge.sql');
  assert.match(purge, /delete from public\.test_execution_leases[\s\S]*where expires_at <= clock_timestamp\(\)/);
  assert.match(purge, /raise exception 'TEST_EXECUTION_ACTIVE'/);
  assert.match(purge, /status in \('queued','running'\)/);
  assert.match(staleRecovery, /last_heartbeat_at < clock_timestamp\(\) - interval '90 seconds'/);
  assert.match(staleRecovery, /admin_purge_all_test_data_converged/);
  assert.match(staleRecovery, /pg_advisory_xact_lock\(2026092001\)/);
  assert.match(staleRecovery, /pg_advisory_xact_lock\(2026092202\)/);
});
