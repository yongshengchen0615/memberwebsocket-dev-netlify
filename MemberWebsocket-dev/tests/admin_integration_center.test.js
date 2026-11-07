const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = source('admin/index.html');
const merchant = source('admin/workspace.html');
const businessWorkspace = source('admin/business-workspace.js');
const businessLine = source('admin/business-line-settings.js');
const platform = source('platform/app.js');
const booking = source('admin/booking-panel-core.js');
const api = source('supabase/functions/api/index.ts');

test('AC-IC-001: integration center assets, navigation and standalone panel are retired', () => {
  assert.doesNotMatch(html, /integration-hub\.(?:js|css)|operationsHub(?:Tab|Panel)|整合中心/);
  for (const name of ['integration-hub.js', 'integration-hub.css']) {
    assert.equal(fs.existsSync(path.join(root, 'admin', name)), false, name + ' must not ship');
  }
});

test('AC-IC-002: navigation order is membership, points, events, calendar, booking, LINE settings', () => {
  const nav = html.match(/<nav class="surface-nav"[^>]*>[\s\S]*?<\/nav>/)?.[0];
  assert.ok(nav, 'admin navigation must exist');
  const staticIds = [...nav.matchAll(/<button\s+id="([^"]+)"[^>]*role="tab"/g)].map(match => match[1]);
  assert.deepEqual(staticIds, ['membersTab', 'cardsTab', 'eventsTab', 'calendarTab', 'lineSettingsTab']);
  assert.match(booking, /tab\.id = 'bookingTab'/);
  assert.match(booking, /const lineSettingsTab = document\.getElementById\('lineSettingsTab'\)/);
  assert.match(booking, /const anchor = \[lineSettingsTab, testModeTab\]/);
  assert.match(booking, /nav\.insertBefore\(tab, anchor\)/);
  assert.match(html, /id="lineSettingsPanel"[^>]*aria-labelledby="lineSettingsTab"/);
});

test('AC-IC-003: integration center cannot reappear through merchant LINE or grant UI', () => {
  assert.doesNotMatch(merchant, /data-merchant-panel="integrations"|整合中心/);
  assert.doesNotMatch(businessWorkspace, /operationsHub|integrations:/);
  assert.doesNotMatch(businessLine, /operationsHub|integrations:|整合中心/);
  assert.match(platform, /visibleFeatureKeys=featureKeys\.filter\(key=>key!=='integrations'&&key!=='testing'&&key!=='usage'\)/);
  assert.match(platform, /featureKeys=\['membership','points','events','calendar','integrations','booking','testing','usage'\]/);
  assert.match(platform, /visibleFeatureKeys\.includes\(key\) && Boolean\(form\.querySelector/);
});

test('AC-IC-004: booking completion and legacy authorized API remain intact', () => {
  assert.match(booking, /function completionPreviewData\(/);
  assert.match(booking, /function openCompletionPreview\(/);
  assert.match(booking, /確認完成並結算/);
  assert.match(booking, /admin\.booking\.status\.complete/);
  const authorize = api.indexOf('const admin = await authorizeAdmin(supabase,identity);');
  const oldRoute = api.indexOf('action === "admin.integration-overview"');
  assert.ok(authorize > 0 && oldRoute > authorize, 'legacy API stays authorized during compatibility window');
});
