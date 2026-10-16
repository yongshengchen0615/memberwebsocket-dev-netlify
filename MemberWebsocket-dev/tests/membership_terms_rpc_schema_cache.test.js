const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationsDir = path.join(__dirname, '../supabase/migrations');

test('membership terms RPC migrations reload the PostgREST schema cache', () => {
  const files = fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const rpcDefinitionIndexes = [];
  const reloadIndexes = [];

  files.forEach((name, index) => {
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    if (/create\s+(?:or\s+replace\s+)?function\s+public\.accept_membership_terms\b/i.test(sql)) {
      rpcDefinitionIndexes.push(index);
    }
    if (/notify\s+pgrst\s*,\s*['"]reload schema['"]\s*;/i.test(sql)) {
      reloadIndexes.push(index);
    }
  });

  assert.ok(rpcDefinitionIndexes.length > 0, 'accept_membership_terms RPC migration must exist');
  assert.ok(reloadIndexes.length > 0, 'a PostgREST schema reload migration must exist');

  const latestRpcDefinition = Math.max(...rpcDefinitionIndexes);
  const latestReload = Math.max(...reloadIndexes);
  assert.ok(
    latestReload >= latestRpcDefinition,
    'PostgREST schema cache must be reloaded after the latest accept_membership_terms signature change',
  );
});
