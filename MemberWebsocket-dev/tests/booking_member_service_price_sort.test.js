const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'booking/app.js'), 'utf8');
const groupBooking = fs.readFileSync(path.join(root, 'booking/group-booking.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'booking/index.html'), 'utf8');
const sortScriptPath = path.join(root, 'booking/service-price-sort.js');

function sorter() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(sortScriptPath, 'utf8'), context);
  return context.window.BookingServicePriceSort;
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.classList = { toggle: () => {} };
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...items) { this.children.push(...items); }
  appendChild(item) { this.children.push(item); return item; }
}

function renderGroups(source, services, priceOrder, withSorter = true) {
  const start = source.indexOf('  function appendServiceCategoryGroups(');
  const end = source.indexOf(source === app ? '\n  function addSelection(' : '\n  function createExtraServiceChoiceRow(', start);
  assert.ok(start >= 0 && end > start, 'must load the actual member grouping function');
  const context = {
    document: { createElement: (tag) => new FakeElement(tag) },
    window: {
      BookingServiceTypeColor: { slot: () => 0 },
      BookingServicePriceSort: withSorter ? sorter() : undefined,
    },
    serviceTypeOf: (service) => String(service?.description || '').replace(/^__TYPE__:/, '').trim(),
    serviceTypeKey: (value) => String(value || '').trim().toLowerCase(),
    serviceTypeRewardText: () => '',
  };
  const render = vm.runInNewContext(
    '(() => { ' + source.slice(start, end) + '; return appendServiceCategoryGroups; })()',
    context
  );
  const container = new FakeElement('div');
  render(
    container,
    services,
    (service) => service,
    (service) => ({ serviceId: service.serviceId }),
    'service-picker',
    priceOrder,
  );
  return JSON.parse(JSON.stringify(container.children.map((section) => ({
    title: section.children[0].textContent,
    ids: section.children[2].children.map((row) => row.serviceId),
  }))));
}

const service = (serviceId, type, priceAmount, title = serviceId) => ({
  serviceId, title, description: '__TYPE__:' + type, priceAmount,
});

test('AC-001: single booking groups stay in their existing order and each group sorts low to high', () => {
  const entries = [
    service('m-high', '按摩', 900),
    service('b-high', '美容', 800),
    service('m-free', '按摩', 0),
    service('b-low', '美容', '200'),
  ];
  const snapshot = JSON.stringify(entries);
  assert.deepEqual(renderGroups(app, entries, true), [
    { title: '按摩（2）', ids: ['m-free', 'm-high'] },
    { title: '美容（2）', ids: ['b-low', 'b-high'] },
  ]);
  assert.equal(JSON.stringify(entries), snapshot, 'do not mutate the server catalog');
});

test('AC-002: group booking participant choices use the same numeric price ordering', () => {
  const entries = [
    service('a-high', '按摩', 2500),
    service('a-low', '按摩', '100'),
    service('a-mid', '按摩', 600),
  ];
  assert.deepEqual(renderGroups(groupBooking, entries, true), [
    { title: '按摩（3）', ids: ['a-low', 'a-mid', 'a-high'] },
  ]);
});

test('AC-003: zero, numeric strings, ties, missing and invalid prices sort deterministically', () => {
  const entries = [
    service('bad', '保養', 'not-a-number'),
    service('tie-z', '保養', 200, '同名'),
    service('high', '保養', '900'),
    service('missing', '保養', null),
    service('free', '保養', 0),
    service('tie-a', '保養', '200', '同名'),
    service('blank', '保養', ''),
  ];
  const ids = sorter().sortEntriesByPrice(entries, (entry) => entry).map((entry) => entry.serviceId);
  assert.deepEqual(Array.from(ids), ['free', 'tie-a', 'tie-z', 'high', 'bad', 'blank', 'missing']);
  assert.deepEqual(entries.map((entry) => entry.serviceId), [
    'bad', 'tie-z', 'high', 'missing', 'free', 'tie-a', 'blank',
  ]);
});

test('AC-004: selected items keep their selection order, independent of available-item sorting', () => {
  const entries = [service('expensive', '按摩', 700), service('cheap', '按摩', 100)];
  for (const source of [app, groupBooking]) {
    assert.deepEqual(renderGroups(source, entries, false), [
      { title: '按摩（2）', ids: ['expensive', 'cheap'] },
    ]);
  }
  const primaryPicker = app.slice(app.indexOf('  function renderServices()'), app.indexOf('  function createServiceChoiceRow('));
  const primarySelected = app.slice(app.indexOf('  function renderSelectedServices()'), app.indexOf('  function createSelectedServiceRow('));
  const extraPicker = groupBooking.slice(groupBooking.indexOf('  function createExtraServicePicker('), groupBooking.indexOf('  function appendServiceCategoryGroups('));
  assert.match(primaryPicker, /'service-picker',\s*true,\s*\)/, 'primary available services enable ascending price');
  assert.match(extraPicker, /'service-picker',\s*true,\s*\)/, 'extra participant services enable ascending price');
  assert.match(primarySelected, /'selected-service-list',\s*\)/, 'primary selected list does not reorder');
  assert.match(extraPicker, /'selected-service-list',\s*\)/, 'extra selected list does not reorder');
  assert.match(app, /addButton\.addEventListener\('click', \(\) => addSelection\(service\)\)/);
  assert.match(groupBooking, /if \(!confirmExtraServiceSelection\(service, selections\)\) return;/);
});

test('AC-005: shared sorter loads before both booking renderers with cache-busted URLs', () => {
  const sorterIndex = html.indexOf('service-price-sort.js?v=member-service-price-asc-20261125-1');
  const groupIndex = html.indexOf('group-booking.js?v=');
  const appIndex = html.indexOf('app.js?v=');
  assert.ok(sorterIndex >= 0 && sorterIndex < groupIndex && sorterIndex < appIndex);
  assert.match(html, /group-booking\.js\?v=[^"]+&service-price-order=20261125-1"/);
  assert.match(html, /app\.js\?v=[^"]+&service-price-order=20261125-1&onsite-edit-cutoff=20261125-1&slot-review-refresh=20261128-2"/);
});

test('AC-006: unavailable optional sorter must not break primary/group booking rendering', () => {
  const entries = [service('expensive', '按摩', 700), service('cheap', '按摩', 100)];
  for (const source of [app, groupBooking]) {
    assert.deepEqual(renderGroups(source, entries, true, false), [
      { title: '按摩（2）', ids: ['expensive', 'cheap'] },
    ], 'missing enhancement script preserves functional booking choices');
  }
});
