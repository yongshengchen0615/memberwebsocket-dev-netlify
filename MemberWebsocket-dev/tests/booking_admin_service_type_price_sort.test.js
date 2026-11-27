const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const core = fs.readFileSync(path.join(root, 'admin/booking-panel-core.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'admin/booking-panel.css'), 'utf8');

function loadGroupingFunction() {
  const start = core.indexOf('  function groupServicesByTypeAndPrice(');
  const end = core.indexOf('\n  function renderServices()', start);
  assert.ok(start !== -1 && end > start, 'service grouping must be declared next to the renderer');
  return vm.runInNewContext(
    `(() => { ${core.slice(start, end)}; return groupServicesByTypeAndPrice; })()`
  );
}

function summarize(groups) {
  return JSON.parse(JSON.stringify(groups.map((group) => ({
    typeName: group.typeName,
    ids: group.items.map((service) => service.serviceId),
  }))));
}

test('AC-001: same booking type stays in one section and known types keep their configured order', () => {
  const group = loadGroupingFunction();
  const services = [
    { serviceId: 'm-high', serviceType: '按摩', title: '精油', priceAmount: 1600 },
    { serviceId: 'b-high', serviceType: '美容', title: '深層', priceAmount: 1200 },
    { serviceId: 'm-low', serviceType: ' 按摩 ', title: '肩頸', priceAmount: 600 },
    { serviceId: 'b-free', serviceType: '美容', title: '諮詢', priceAmount: 0 },
    { serviceId: 'other', serviceType: '', title: '未指定', priceAmount: 100 },
  ];
  const originalOrder = services.map((service) => service.serviceId);
  assert.deepEqual(summarize(group(services, [{ name: '美容' }, { name: '按摩' }])), [
    { typeName: '美容', ids: ['b-free', 'b-high'] },
    { typeName: '按摩', ids: ['m-low', 'm-high'] },
    { typeName: '未分類', ids: ['other'] },
  ]);
  assert.deepEqual(services.map((service) => service.serviceId), originalOrder, 'must not mutate API response');
});

test('AC-002: type price sorting is numeric, ascending, stable for ties and invalid values', () => {
  const group = loadGroupingFunction();
  const services = [
    { serviceId: 'invalid', serviceType: '保養', title: '未知', priceAmount: 'N/A' },
    { serviceId: 'high', serviceType: '保養', title: '高價', priceAmount: '900' },
    { serviceId: 'tie-b', serviceType: '保養', title: '同價', priceAmount: 200 },
    { serviceId: 'tie-a', serviceType: '保養', title: '同價', priceAmount: '200' },
    { serviceId: 'zero', serviceType: '保養', title: '免費', priceAmount: 0 },
    { serviceId: 'missing', serviceType: '保養', title: '未定', priceAmount: null },
  ];
  assert.deepEqual(summarize(group(services, [{ name: '保養' }])), [
    { typeName: '保養', ids: ['zero', 'tie-a', 'tie-b', 'high', 'missing', 'invalid'] },
  ]);
});

test('AC-003: unknown categories are grouped without dropping services, and unclassified comes last', () => {
  const group = loadGroupingFunction();
  const rows = [
    { serviceId: 'x', serviceType: '未知類型', title: '未知', priceAmount: 1, isActive: false },
    { serviceId: 'blank', serviceType: ' ', title: '無類型', priceAmount: 1 },
    { serviceId: 'known', serviceType: '已設定', title: '已設定', priceAmount: 3 },
  ];
  assert.deepEqual(summarize(group(rows, [{ name: '已設定' }])), [
    { typeName: '已設定', ids: ['known'] },
    { typeName: '未知類型', ids: ['x'] },
    { typeName: '未分類', ids: ['blank'] },
  ]);
  assert.deepEqual(summarize(group([], [{ name: '已設定' }])), []);
});

test('AC-004: admin rendering keeps selection, editing, deletion, scheduled pricing and accessible group headings', () => {
  assert.match(core, /groupServicesByTypeAndPrice\(rows, state\.catalog\.serviceTypes \|\| \[\]\)/);
  assert.match(core, /serviceGroup\.setAttribute\('aria-labelledby', groupTitle\.id\)/);
  assert.match(core, /serviceGroupList\.appendChild\(row\)/);
  assert.match(core, /state\.selected\.add\(service\.serviceId\)/);
  assert.match(core, /openServiceModal\(service\)/);
  assert.match(core, /deleteService\(service\)/);
  assert.match(core, /BookingPriceEditor\.open/);
  assert.match(core, /updateBatchButtons\(\)/);
  assert.match(css, /#bookingPanel \.booking-admin-service-group\s*\{/);
  assert.match(css, /#bookingPanel \.booking-admin-service-group-list\s*\{/);
});

test('AC-005: admin entry and loader bust stale CSS and renderer caches', () => {
  const html = fs.readFileSync(path.join(root, 'admin/index.html'), 'utf8');
  const loader = fs.readFileSync(path.join(root, 'admin/booking-panel.js'), 'utf8');
  assert.match(html, /booking-panel\.css\?v=[^"']+type-price-20261125-1/);
  assert.match(html, /booking-panel\.js\?v=[^"']+type-price-20261125-1/);
  assert.match(loader, /load\('booking-panel-core\.js', '[^']+type-price-20261125-1-onsite-edit-notice-20261125-1-booking-id-20261125-1-member-reminder-20261125-1-holiday-notice-20261127-1'\)/);
});

test('AC-006: real renderer creates one DOM block per type with sorted rows and keeps checkbox actions', () => {
  class FakeElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.style = {};
      this.attributes = {};
      this.className = '';
      this.classList = { toggle: () => {} };
      this.events = {};
    }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); }
    prepend(...children) { this.children.unshift(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
  }
  const serviceList = new FakeElement('div');
  const selected = new Set(['high']);
  const state = {
    catalog: {
      serviceTypes: [{ name: '美容' }, { name: '按摩' }],
      services: [
        { serviceId: 'high', title: '精油按摩', serviceType: '按摩', priceAmount: 1500, durationMinutes: 90, isActive: true },
        { serviceId: 'beauty', title: '保養', serviceType: '美容', priceAmount: 700, durationMinutes: 60, isActive: false },
        { serviceId: 'low', title: '肩頸按摩', serviceType: '按摩', priceAmount: 300, durationMinutes: 30, isActive: true },
      ],
    },
    selected,
    config: { pricePublishing: true },
  };
  const elements = {
    bookingAdminServiceList: serviceList,
    bookingAdminServiceEmpty: new FakeElement('div'),
  };
  let batchUpdates = 0;
  const sandbox = {
    state,
    els: elements,
    document: { createElement: (tag) => new FakeElement(tag) },
    window: { BookingPriceEditor: { open: () => {} } },
    formatMoney: (amount) => `NT$${amount}`,
    actionButton: (label) => {
      const button = new FakeElement('button');
      button.textContent = label;
      return button;
    },
    updateBatchButtons: () => { batchUpdates += 1; },
  };
  const groupStart = core.indexOf('  function groupServicesByTypeAndPrice(');
  const renderEnd = core.indexOf('\n  function updateBatchButtons()', groupStart);
  assert.ok(groupStart > 0 && renderEnd > groupStart);
  vm.runInNewContext(
    `${core.slice(groupStart, renderEnd)}\nrenderServices();`,
    sandbox
  );
  assert.equal(serviceList.children.length, 2);
  assert.deepEqual(serviceList.children.map((group) => group.children[0].children[0].textContent), [
    '美容（1 項）',
    '按摩（2 項）',
  ]);
  const massageRows = serviceList.children[1].children[1].children;
  const rowTitle = (row) => row.children[0].children[1].children[0].textContent;
  assert.deepEqual(massageRows.map(rowTitle), ['肩頸按摩', '精油按摩']);
  assert.equal(massageRows[1].children[0].children[0].checked, true);
  assert.deepEqual(massageRows[0].children[1].children.map((button) => button.textContent), ['調整價格', '修改', '刪除']);
  const lowCheckbox = massageRows[0].children[0].children[0];
  lowCheckbox.checked = true;
  lowCheckbox.events.change();
  assert.equal(selected.has('low'), true);
  assert.equal(batchUpdates, 2);
});
