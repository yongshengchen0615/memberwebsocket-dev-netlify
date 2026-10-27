const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'platform/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'admin/workspace.html'), 'utf8');
const start = script.indexOf('  function selectMerchantWorkspaceTab(requested) {');
const end = script.indexOf('  function selectMerchantPanel(feature, reveal = true) {', start);
assert.ok(start >= 0 && end > start, 'Merchant tab controller must remain testable');

function createFixture(granted) {
  const nodes = {};
  let focused = '';
  for (const id of ['merchantOverviewTab', 'merchantLineSettingsTab', 'merchantOverviewPanel', 'merchantLineSettingsPanel']) {
    nodes[id] = { id, hidden: id === 'merchantLineSettingsTab' || id === 'merchantLineSettingsPanel',
      disabled: id === 'merchantLineSettingsTab', tabIndex: 0, attrs: {}, listeners: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(k, fn) { this.listeners[k] = fn; },
      focus() { focused = id; } };
  }
  const context = { state: { features: { booking: '預約' }, merchant: { features: { booking: granted } } },
    merchantEntry:true,merchantWorkspaceTab: 'overview', el: id => nodes[id] };
  const declaration=prefix=>script.slice(script.indexOf(prefix),script.indexOf('\n',script.indexOf(prefix)));
  vm.runInNewContext(declaration('  const featureLiffNames=')+'\n'+declaration('  const hasFeatureLine =')+'\n'+script.slice(start, end) + '\nthis.chooseTab = selectMerchantWorkspaceTab;', context);
  return { nodes, context, focus: () => focused,
    press(id, key) { let prevented = false;
      nodes[id].listeners.keydown({ key, preventDefault() { prevented = true; } });
      return prevented;
    } };
}

test('AC-ADM-UX-006: Arrow keys and Home/End select the visible panel, focus it and update the roving tab stop', () => {
  const view = createFixture(true), n = view.nodes;
  view.context.chooseTab('overview');
  assert.equal(n.merchantOverviewTab.tabIndex, 0);
  assert.equal(n.merchantLineSettingsTab.tabIndex, -1);
  assert.equal(view.press('merchantOverviewTab', 'ArrowRight'), true);
  assert.equal(view.focus(), 'merchantLineSettingsTab');
  assert.equal(n.merchantLineSettingsTab.attrs['aria-selected'], 'true');
  assert.equal(n.merchantOverviewTab.attrs['aria-selected'], 'false');
  assert.equal(n.merchantLineSettingsPanel.hidden, false);
  assert.equal(n.merchantOverviewPanel.hidden, true);
  assert.equal(n.merchantLineSettingsTab.tabIndex, 0);
  assert.equal(n.merchantOverviewTab.tabIndex, -1);
  assert.equal(view.press('merchantLineSettingsTab', 'Home'), true);
  assert.equal(view.focus(), 'merchantOverviewTab');
  assert.equal(view.press('merchantOverviewTab', 'End'), true);
  assert.equal(view.focus(), 'merchantLineSettingsTab');
  assert.equal(view.press('merchantLineSettingsTab', 'ArrowLeft'), true);
  assert.equal(n.merchantOverviewTab.attrs['aria-selected'], 'true');
  assert.equal(view.press('merchantOverviewTab', 'Escape'), false);
});

test('AC-ADM-UX-002: withheld features stay hidden and disabled even with forged tab selection or keyboard input', () => {
  const view = createFixture(false), n = view.nodes;
  view.context.chooseTab('line');
  assert.equal(n.merchantOverviewTab.attrs['aria-selected'], 'true');
  assert.equal(n.merchantLineSettingsTab.hidden, true);
  assert.equal(n.merchantLineSettingsTab.disabled, true);
  assert.equal(n.merchantLineSettingsPanel.hidden, true);
  assert.equal(view.press('merchantOverviewTab', 'ArrowRight'), false);
  assert.equal(view.focus(), '');
  assert.equal(n.merchantOverviewTab.tabIndex, 0);
  assert.equal(n.merchantLineSettingsTab.tabIndex, -1);
});

test('AC-ADM-UX-006: existing accessible tab labels and controlled panel associations remain unchanged', () => {
  for (const [id, panel] of [['merchantOverviewTab', 'merchantOverviewPanel'], ['merchantLineSettingsTab', 'merchantLineSettingsPanel']]) {
    assert.match(html, new RegExp('id="' + id + '"[^>]*role="tab"[^>]*aria-controls="' + panel + '"'));
    assert.match(html, new RegExp('id="' + panel + '"[^>]*role="tabpanel"[^>]*aria-labelledby="' + id + '"'));
  }
  assert.match(html, /id="merchantWorkspaceNav"[^>]*role="tablist"/);
});
