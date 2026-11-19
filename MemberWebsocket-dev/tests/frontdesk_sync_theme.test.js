const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('AC-FD-SYNC-001: merchant heartbeat and legacy admin revalidate the same server record', () => {
  const standalone = read('admin/frontdesk-settings/frontdesk-settings-page.js');
  const legacy = read('admin/business-line-settings.js');
  const settings = read('admin/frontdesk-settings.js');
  assert.ok(standalone.includes('FrontdeskSettings.refresh({ business })'));
  assert.match(legacy, /window\.BusinessWorkspace\?\.apply\(\{ business: tenant, features: grants \}\)/);
  assert.match(legacy, /window\.addEventListener\('focus', refreshOnResume\)/);
  assert.match(settings, /request\('platform\.frontdesk\.get'\)/);
  assert.match(settings, /window\.addEventListener\('frontdesk:refresh', onRefresh\)/);
  assert.match(settings, /window\.BroadcastChannel\('frontdesk-settings-v1'\)/);
});
test('AC-FD-SYNC-002: unsaved drafts do not get overwritten, and subscription is disposed on revoke', () => {
  const settings = read('admin/frontdesk-settings.js');
  assert.match(settings, /if \(dirty && !force\)/);
  assert.match(settings, /active\.get\(root\)\?\.dispose\(\)/);
  assert.match(settings, /channel\?\.close\(\)/);
  assert.match(settings, /JSON\.stringify\(\[result\.version, result\.frontdesk, result\.staff\]\)/);
});
test('AC-FD-THEME-001: merchant frontdesk follows explicit light and dark tokens, not OS preference', () => {
  const css = read('frontdesk/styles.css');
  assert.match(css, /\.frontdesk-settings\{[\s\S]*?--fd-card:var\(--theme-surface-raised/);
  assert.match(css, /--fd-primary:var\(--ui-primary/);
  assert.match(css, /--fd-on-primary:var\(--ui-primary-contrast/);
  assert.match(css, /html\[data-theme="dark"\] \.frontdesk-settings/);
  assert.doesNotMatch(css, /@media\(prefers-color-scheme:dark\)\{\.frontdesk-shell,\.frontdesk-settings/);
  assert.doesNotMatch(css, /\.theme-dark \.frontdesk-settings\{--fd-card:#/);
});

test('AC-FD-SYNC-003: standalone page reconciles cross-device applications and releases its heartbeat', () => {
  const page = read('admin/frontdesk-settings/frontdesk-settings-page.js');
  const check = page.slice(page.indexOf('async function checkAccess()'), page.indexOf('async function start()'));
  assert.match(check,/assertAccess\(data\);[\s\S]*?window\.FrontdeskSettings\.refresh\(\{ business \}\)/);
  assert.match(page,/window\.setInterval\(/);
  assert.match(page,/window\.clearInterval\(/);
  assert.match(page,/timer-policy: heartbeat; reason=/);
  assert.match(page,/function dismiss\([\s\S]*?stopReconciliation\(\)/);
  assert.match(page,/addEventListener\('pagehide',[\s\S]*?stopReconciliation\(\)/);
});
