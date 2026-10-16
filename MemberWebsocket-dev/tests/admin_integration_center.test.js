const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin', 'index.html'), 'utf8');
const hub = fs.readFileSync(path.join(root, 'admin', 'integration-hub.js'), 'utf8');
const hubCss = fs.readFileSync(path.join(root, 'admin', 'integration-hub.css'), 'utf8');
const booking = fs.readFileSync(path.join(root, 'admin', 'booking-panel-core.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'supabase', 'functions', 'api', 'index.ts'), 'utf8');

test('admin loads the integration center assets', () => {
  assert.match(html, /integration-hub\.css\?v=admin-integration-center-20260925-1/);
  assert.match(html, /integration-hub\.js\?v=admin-integration-center-20261005-2/);
  assert.match(hub, /operationsHubTab/);
  assert.match(hub, /整合營運中心/);
  assert.match(hubCss, /\.integration-metric-grid/);
});

test('integration overview remains behind existing admin authorization', () => {
  const authorize = api.indexOf('const admin = await authorizeAdmin(supabase,identity);');
  const route = api.indexOf('action === "admin.integration-overview"');
  assert.ok(authorize > 0);
  assert.ok(route > authorize, 'integration route must be resolved only after authorizeAdmin');
  assert.match(api, /adminIntegrationOverview\(supabase\)/);
});

test('integration overview minimizes notification and audit identity exposure', () => {
  const start = api.indexOf('async function adminIntegrationOverview');
  const end = api.indexOf('async function handleAction', start);
  assert.ok(start >= 0 && end > start);
  const section = api.slice(start, end);
  assert.doesNotMatch(section, /scheduled_grant_messages"\)\s*\.select\([^\n]*message_text/);
  assert.doesNotMatch(section, /audit_logs"\)\s*\.select\([^\n]*actor_line_user_id/);
  assert.match(section, /memberDisplayName/);
  assert.match(section, /memberCode/);
});

test('integration center covers recommended cross-domain read models', () => {
  for (const marker of [
    '點數自動來源',
    '活動期間與日曆關聯',
    '最近預約完成結算',
    '固定票券規則',
    '通知中心',
    'Audit Timeline',
  ]) assert.ok(hub.includes(marker), marker);
  assert.match(hub, /calendar-batch/);
  assert.match(hub, /booking-services/);
  assert.match(hub, /member-grant/);
});

test('booking completion uses a settlement preview while server remains authoritative', () => {
  assert.match(booking, /function completionPreviewData\(/);
  assert.match(booking, /function openCompletionPreview\(/);
  assert.match(booking, /確認完成並結算/);
  assert.match(booking, /admin\.booking\.status\.complete/);
  assert.doesNotMatch(booking, /status === 'completed' && !window\.confirm/);
  assert.match(api, /booking_completion_settlements/);
});

test('integration center uses shared date and status presentation helpers', () => {
  assert.match(hub, /function statusBadge\(/);
  assert.match(hub, /function formatDateRange\(/);
  assert.match(hub, /function formatDateTime\(/);
  assert.match(hubCss, /\.integration-status\.is-active/);
  assert.match(hubCss, /@media \(max-width: 520px\)/);
});
