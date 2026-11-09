const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20261109175000_restore_tenant_ticket_service_groups.sql'), 'utf8');

test('restore missed service-group migration in business schemas only', () => {
  assert.ok(migration.includes("where nspname ~ '^business_[0-9a-f]{32}$'"));
  assert.doesNotMatch(migration, /where nspname='public' or/);
  assert.match(migration, /PARTIAL_TENANT_TICKET_SERVICE_GROUPS/);
  assert.equal((migration.match(/notify pgrst/g) || []).length, 1);
});

test('both tenant ticket sources have safe empty-group defaults and integrity guards', () => {
  for (const table of ['event_tickets', 'point_card_rewards']) {
    assert.ok(migration.includes(`alter table %I.${table} add column if not exists required_service_groups jsonb not null default ''[]''::jsonb`));
  }
  assert.match(migration, /event_ticket_service_groups_check/);
  assert.match(migration, /point_reward_service_groups_check/);
  assert.match(migration, /event_ticket_service_groups_guard/);
  assert.match(migration, /point_reward_service_groups_guard/);
  assert.match(migration, /INVALID_REQUIRED_SERVICE_GROUPS/);
});

test('tenant service requirement evaluation and old ticket reservation checks remain enforced', () => {
  for (const functionName of [
    'ticket_service_groups_valid',
    'booking_meets_required_service_groups',
    'booking_meets_required_services',
    'booking_ticket_matches_services',
    'ticket_has_service_requirement',
    'validate_booking_benefit_service_requirement_row',
    'validate_booking_service_requirements_on_completion',
    'prevent_delete_ticket_required_service_item',
  ]) assert.ok(migration.includes(functionName), functionName);
  assert.match(migration, /revoke all on function %I.%s from public,anon,authenticated/);
  assert.match(migration, /grant execute on function %I.%s to service_role/);
});

test('repair fails closed on partially upgraded tenants and never changes member data', () => {
  const detection = migration.indexOf('if exists (');
  const refusal = migration.indexOf("raise exception 'PARTIAL_TENANT_TICKET_SERVICE_GROUPS: %',s;");
  const firstAlter = migration.indexOf("alter table %I.event_tickets add column if not exists");
  assert.ok(detection !== -1 && detection < refusal && refusal < firstAlter);
  assert.doesNotMatch(migration, /(?:truncate|delete\s+from|drop\s+table|update\s+members|update\s+bookings)\b/i);
  assert.match(migration, /coalesce\(r\.required_service_groups,''\[\]''::jsonb\)/);
  assert.match(migration, /coalesce\(et\.required_service_groups,''\[\]''::jsonb\)/);
  assert.match(migration, /create trigger event_ticket_service_groups_guard/);
  assert.match(migration, /create trigger point_reward_service_groups_guard/);
});
