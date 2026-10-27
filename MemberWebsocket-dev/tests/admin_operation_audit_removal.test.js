const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const source = file => readFileSync(join(root, file), 'utf8');

test('AC-001: the standalone admin operation audit UI and its assets are removed', () => {
  const html = source('admin/index.html');
  assert.doesNotMatch(html, /operation-audit\.(?:js|css)/);
  assert.equal(existsSync(join(root, 'admin/operation-audit.js')), false);
  assert.equal(existsSync(join(root, 'admin/operation-audit.css')), false);
});

test('AC-002 and AC-004: merchant navigation no longer opens standalone audit, but member usage remains', () => {
  const html = source('admin/index.html');
  const workspace = source('admin/business-workspace.js');
  const memberTabs = source('admin/member-workspace-tabs.js');
  assert.doesNotMatch(workspace, /usage\s*:\s*['"]operationAudit['"]/);
  assert.match(workspace, /membership:'members'/);
  assert.match(workspace, /getElementById\('memberUsageTab'\)/);
  assert.match(html, /id="memberUsageTab"/);
  assert.match(html, /id="memberUsagePanel"/);
  assert.match(html, /id="memberRecordsOpenUsage"/);
  assert.match(memberTabs, /key: 'usage'/);
});

test('AC-003 and AC-005: retired query route cannot expose logs; protected audit writes remain', () => {
  const api = source('supabase/functions/api/index.ts');
  assert.doesNotMatch(api, /if \(action === "admin\.audit\.query"\)/);
  assert.match(api, /const admin = await authorizeAdmin\(supabase,identity\)/);
  assert.match(api, /supabase\.from\("audit_logs"\)\.insert/);
  assert.match(api, /ACTION_NOT_FOUND/);
});
