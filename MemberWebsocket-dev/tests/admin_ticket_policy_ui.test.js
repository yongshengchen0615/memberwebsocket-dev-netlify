const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('admin/index.html');
const css = read('admin/ticket-policy-settings.css');
const point = read('admin/pointcard-redemption-limit.js');
const event = read('admin/event-ticket-redemption-limit.js');
const tier = read('admin/ticket-visibility.js');

test('admin loads the shared ticket policy stylesheet and versioned settings scripts', () => {
  assert.match(html, /ticket-policy-settings\.css\?v=policy-admin-ui-20261014-1/);
  for (const file of ['pointcard-redemption-limit', 'event-ticket-redemption-limit', 'ticket-visibility']) {
    assert.ok(html.includes(file + '.js?v=policy-admin-ui-20261014-1'));
  }
});

test('global point and event limits retain independent backend operations and zero as unlimited', () => {
  for (const [src, endpoint, key] of [
    [point, 'pointcard-extension-api', 'maxTicketsPerRedemption'],
    [event, 'event-ticket-extension-api', 'maxTicketsPerDay']
  ]) {
    assert.ok(src.includes(endpoint));
    assert.match(src, /parsed >= 0 && parsed <= 50/);
    assert.match(src, /0 代表不限張數/);
    assert.match(src, /admin\.settings\.get/);
    assert.match(src, /admin\.settings\.save/);
    assert.match(src, /expectedUpdatedAt: state\.updatedAt/);
    assert.ok(src.includes(key));
    assert.match(src, /state\.savedLimit !== null/);
    assert.match(src, /value === null/);
    assert.match(src, /data-policy-limit="0"/);
    assert.match(src, /data-policy-limit="10"/);
    assert.match(src, /aria-pressed/);
    assert.ok(src.includes('panel.dataset.dirty'));
    assert.match(src, /有尚未儲存的變更/);
    assert.match(src, /仍須符合|不會改變/);
  }
  assert.match(point, /單次最多使用票券數/);
  assert.match(event, /每日最多使用活動票券數/);
  assert.match(event, /Asia\/Taipei/);
});

test('member-tier visibility UI separates visibility from actual eligibility', () => {
  assert.match(tier, /admin\.ticket-visibility\.get/);
  assert.match(tier, /admin\.ticket-visibility\.save/);
  assert.match(tier, /expectedUpdatedAt: version/);
  assert.match(tier, /eligible_only/);
  assert.match(tier, /higher_preview/);
  assert.match(tier, /不改變會員資格或實際使用權限/);
  assert.match(tier, /伺服器仍會驗證會員等級及票券規則/);
  assert.match(tier, /較高階級專屬內容會以鎖定狀態顯示/);
  assert.match(tier, /有尚未儲存的變更/);
  assert.doesNotMatch(tier, /admin\.roles\.save|admin\.permissions\.save/);
});

test('settings surfaces support mobile layouts, accessible status and keyboard focus', () => {
  assert.match(css, /\.usage-policy-body/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /grid-template-columns: 1fr/);
  assert.match(css, /\[aria-pressed="true"\]/);
  assert.match(css, /min-height: 44px/);
  for (const src of [point, event, tier]) {
    assert.match(src, /aria-live="polite"/);
    assert.match(src, /role="status"/);
  }
});
