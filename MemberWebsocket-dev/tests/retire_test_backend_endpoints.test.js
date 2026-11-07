'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'supabase/retirement/retired-endpoints.json'),'utf8'));
const tombstone = fs.readFileSync(path.join(root, 'supabase/retirement/retired-test-endpoint.ts'),'utf8');

test('AC-006: exactly the five historical test endpoints require public decommissioning', () => {
  assert.deepEqual([...manifest.retiredFunctions].sort(), [
    'e2e-artifact-api', 'e2e-artifact-retention', 'test-control-api',
    'test-mode-api', 'user-test-api',
  ].sort());
  assert.equal(manifest.expectedStatus, 410);
  assert.equal(manifest.expectedErrorCode, 'TEST_FEATURE_RETIRED');
});

test('AC-007: retired endpoint cannot accept identity, create accounts, or access storage', () => {
  assert.match(tombstone, /Deno\.serve/);
  assert.match(tombstone, /status: 410/);
  assert.match(tombstone, /TEST_FEATURE_RETIRED/);
  assert.match(tombstone, /cache-control.*no-store/);
  assert.doesNotMatch(tombstone, /createClient|supabase\.from|fetch\(|service_role|access_token|testSessionToken/);
});

test('AC-008: retired endpoint is outside deployable Supabase functions tree', () => {
  const relative = 'supabase/retirement/retired-test-endpoint.ts';
  assert.ok(fs.existsSync(path.join(root,relative)));
  assert.equal(relative.startsWith('supabase/functions/'), false);
});
