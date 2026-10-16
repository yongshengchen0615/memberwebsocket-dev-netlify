const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'admin', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'admin', 'styles.css'), 'utf8');
const fixed = fs.readFileSync(path.join(root, 'admin', 'fixed-ticket-admin.js'), 'utf8');

test('event ticket editor exposes reusable audience presets without changing role semantics', () => {
  for (const preset of ['all', 'general', 'silver-plus', 'gold-plus', 'platinum']) {
    assert.ok(html.includes('data-audience-preset="' + preset + '"'), preset);
  }
  assert.match(html, /權益資格只控制會員等級，不代表管理權限/);
  assert.match(app, /function audiencePresetTierKeys\(/);
  assert.match(app, /function handleAudiencePresetClick\(/);
  assert.match(app, /function audiencePresetForTierKeys\(/);
  assert.match(app, /aria-pressed/);
});

test('audience presets map to the existing allowed tier keys only', () => {
  assert.match(app, /all:\s*EVENT_TICKET_TIER_KEYS/);
  assert.match(app, /general:\s*\['general'\]/);
  assert.match(app, /'silver-plus':\s*\['silver', 'gold', 'platinum'\]/);
  assert.match(app, /'gold-plus':\s*\['gold', 'platinum'\]/);
  assert.match(app, /platinum:\s*\['platinum'\]/);
  assert.match(app, /collectEventTicketAllowedTiers\(\)/);
});

test('fixed ticket editor continues to reuse the shared event-ticket audience selector', () => {
  assert.match(fixed, /#eventTicketAllowedTiers input\[name="eventTicketAllowedTierKey"\]/);
  assert.match(fixed, /allowedTierKeys:/);
  assert.match(fixed, /請至少選擇一個適用會員等級/);
  assert.doesNotMatch(fixed, /role|permission/i);
});

test('ticket and event editors share theme-token surfaces and responsive audience layout', () => {
  assert.match(css, /Shared ticket editor \+ audience selector 2026-09-25/);
  assert.match(css, /\.ticket-workspace \.editor form/);
  assert.match(css, /\.event-ticket-workspace \.editor form/);
  assert.match(css, /\.audience-preset\.active/);
  assert.match(css, /\.event-ticket-tier-options\.audience-tier-grid/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /var\(--theme-surface-muted/);
});
