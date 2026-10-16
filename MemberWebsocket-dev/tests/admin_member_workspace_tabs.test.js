const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'admin', 'member-workspace-tabs.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'admin', 'member-workspace-tabs.js'), 'utf8');

test('member card admin separates directory, usage history, tier settings, and legal terms into workspaces', () => {
  assert.match(html, /id="memberDirectoryTab"[\s\S]*aria-controls="memberDirectoryPanel"/);
  assert.match(html, /id="memberUsageTab"[\s\S]*aria-controls="memberUsagePanel"/);
  assert.match(html, /id="memberTierSettingsTab"[\s\S]*aria-controls="memberTierSettingsPanel"/);
  assert.match(html, /id="memberTermsTab"[\s\S]*aria-controls="memberTermsPanel"/);
  assert.match(html, /id="memberDirectoryPanel" class="member-workspace-panel"/);
  assert.match(html, /id="memberUsagePanel" class="member-workspace-panel member-usage-panel hidden"/);
  assert.match(html, /id="memberTierSettingsPanel" class="member-workspace-panel hidden"/);
  assert.match(html, /id="memberTermsPanel" class="member-workspace-panel hidden"/);

  const directory = html.indexOf('id="memberDirectoryPanel"');
  const usage = html.indexOf('id="memberUsagePanel"');
  const tier = html.indexOf('id="memberTierSettingsPanel"');
  const terms = html.indexOf('id="memberTermsPanel"');
  assert.ok(directory > -1 && usage > directory && tier > usage && terms > tier);
  assert.ok(html.indexOf('id="memberSearch"', directory) < tier);
  assert.ok(html.indexOf('id="tierSettingsForm"', tier) < terms);
  assert.ok(html.indexOf('id="termsDraftForm"', terms) > terms);
});

test('grant preset management stays with daily member operations', () => {
  const directory = html.indexOf('id="memberDirectoryPanel"');
  const tier = html.indexOf('id="memberTierSettingsPanel"');
  const button = html.indexOf('id="manageGrantMessagesButton"');
  assert.ok(button > directory && button < tier);
  assert.equal((html.match(/id="manageGrantMessagesButton"/g) || []).length, 1);
});

test('member workspace tabs support keyboard navigation and panel visibility', () => {
  assert.match(js, /ArrowRight/);
  assert.match(js, /ArrowLeft/);
  assert.match(js, /Home/);
  assert.match(js, /End/);
  assert.match(js, /setAttribute\('aria-selected'/);
  assert.match(js, /classList\.toggle\('hidden'/);
  assert.match(js, /tabIndex = selected \? 0 : -1/);
});

test('member workspace navigation stays compact and theme-aware', () => {
  assert.match(css, /\.member-workspace-nav\s*\{[\s\S]*grid-template-columns:\s*repeat\(3/);
  assert.match(css, /html\[data-theme\][\s\S]*\.member-workspace-tab/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*overflow-x:\s*auto/);
  assert.match(html, /member-workspace-tabs\.css\?v=member-workspace-tabs-20261014-2/);
  assert.match(html, /member-workspace-tabs\.js\?v=member-workspace-tabs-20261014-2/);
});
