const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const migration = read('supabase/migrations/20261119150000_frontdesk_independent_feature_grant.sql');
const root = read('platform/app.js');
const policy = read('supabase/functions/_shared/platform-policy.mjs');
const handler = read('supabase/functions/_shared/platform-handler.mjs');
const frontdesk = read('supabase/functions/_shared/frontdesk-admin.mjs');
const settings = read('admin/business-line-settings.js');
const workspace = read('admin/business-workspace.js');

test('AC-FD-GRANT-001: platform grants a distinct frontdesk feature and defaults missing grants to denied',()=>{
  assert.match(policy,/frontdesk:\s*'櫃檯設定'/);
  assert.match(root,/featureKeys=\[[^\]]*'frontdesk'/);
  assert.match(root,/frontdesk\s*&&\s*application/); // updated implementation can ensure qualified ready link
  assert.match(migration,/create or replace function public\.platform_features_valid/);
  assert.match(migration,/p \? 'frontdesk'/);
  assert.match(root,/data\-grant\-feature/);
});

test('AC-FD-GRANT-002: merchant portal and admin shell require both booking and frontdesk grants',()=>{
  assert.match(root,/tenant\?\.features\?\.booking===true\s*&&\s*tenant\?\.features\?\.frontdesk===true/);
  assert.match(workspace,/data\.features\.booking===true\s*&&\s*data\.features\.frontdesk===true/);
  assert.match(settings,/grants\.booking===true\s*&&\s*grants\.frontdesk===true/);
});

test('AC-FD-GRANT-003: merchant API denies frontdesk read/write before replay or provider calls',()=>{
  assert.match(frontdesk,/tenant\.features\?\.frontdesk\s*!==\s*true/);
  assert.match(frontdesk,/tenant\.features\?\.booking\s*!==\s*true/);
  assert.match(handler,/frontdeskAdmin\(/);
});

test('AC-FD-GRANT-004: SQL protects public context, staff application, booking operations, delivery and replay',()=>{
  assert.match(migration,/create or replace function platform_private\.frontdesk_tenant/);
  assert.match(migration,/t\.features->>'frontdesk' is distinct from 'true'/);
  assert.match(migration,/create or replace function public\.platform_frontdesk_admin/);
  assert.match(migration,/create or replace function public\.platform_frontdesk_replay/);
  assert.match(migration,/create or replace function public\.platform_update_tenant_features/);
});

test('AC-FD-GRANT-005: revocation drains pending frontdesk deliveries and regrant reprojects approved staff',()=>{
  assert.match(migration,/frontdesk_notice_recipients/);
  assert.match(migration,/FRONTDESK_FEATURE_DISABLED/);
  assert.match(migration,/status in \('pending','sending'\)/);
  assert.match(migration,/on conflict \(line_user_id\) do nothing/);
  assert.match(migration,/TENANT_FEATURES_UPDATED/);
});
