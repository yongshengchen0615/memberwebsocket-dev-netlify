const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('first and later participants use the same final grouped service structure', () => {
  const app = read('booking/app.js');
  const group = read('booking/group-booking.js');

  for (const source of [app, group]) {
    assert.ok(source.includes("section.className ="));
    assert.ok(source.includes('service-info service-type-group'));
    assert.ok(source.includes("list.className = listClass"));
    assert.ok(source.includes("row.className = 'service-choice'"));
    assert.ok(source.includes("row.className = 'selected-service-item'"));
    assert.ok(source.includes("service-add-button"));
    assert.ok(source.includes("selected-service-remove"));
  }

  assert.ok(group.includes("picker.className = 'service-picker-fieldset'"));
  assert.ok(group.includes("selectedFieldset.className = 'selected-service-fieldset'"));
  assert.ok(group.includes("choices.className = 'service-picker'"));
  assert.ok(group.includes("selectedList.className = 'selected-service-list'"));
});

test('duplicate item and same-type warning rules stay aligned', () => {
  const app = read('booking/app.js');
  const group = read('booking/group-booking.js');
  for (const message of [
    '已加入兩次，無法再重複加入。',
    '目前已選擇相同類型',
    '仍要加入這個預約項目嗎？',
  ]) {
    assert.ok(app.includes(message), message);
    assert.ok(group.includes(message), message);
  }
});

test('selection summary shows amount and technician for every participant', () => {
  const group = read('booking/group-booking.js');
  assert.ok(group.includes('金額：'));
  assert.ok(group.includes('預約技師：'));
  assert.ok(group.includes('總服務時間：'));
  assert.ok(group.includes('總金額：'));
  assert.ok(group.includes('technicianLabel(state.participantTechnicians[index])'));
});

test('calendar date selection exits edit mode and clears grouped edit state', () => {
  const app = read('booking/app.js');
  const group = read('booking/group-booking.js');

  assert.ok(app.includes("window.addEventListener('booking:date-selected', beginNewBookingFromDateSelection)"));
  assert.ok(app.includes('if (state.editing) endEditing()'));
  assert.ok(group.includes("window.addEventListener('booking:date-selected'"));
  assert.ok(group.includes("state.editingBookingId = ''"));
  assert.ok(group.includes('resetGroupSelection()'));
});

test('primary participant summary follows add/remove state synchronously', () => {
  const app = read('booking/app.js');
  const group = read('booking/group-booking.js');

  assert.ok(app.includes("window.dispatchEvent(new CustomEvent('booking:selection-changed'"));
  assert.ok(group.includes("window.addEventListener('booking:selection-changed'"));
  assert.ok(group.includes('syncPrimaryItems(event?.detail?.items)'));
  assert.ok(group.includes('updateSelectionSummary()'));
  assert.ok(!group.includes('queueMicrotask(updateSelectionSummary)'));
});

test('service type blocks use stable distinct colors across every participant renderer', () => {
  const app = read('booking/app.js');
  const group = read('booking/group-booking.js');
  const css = read('booking/member-booking-format.css');

  assert.ok(app.includes('BookingServiceTypeColor?.slot?.(group.label)'));
  assert.ok(group.includes('BookingServiceTypeColor.slot(group.label)'));
  for (let index = 0; index < 12; index += 1) {
    assert.ok(css.includes('service-type-color-' + index + ' {'));
  }
  assert.ok(css.includes('service-info.service-type-group > strong::before'));
});

test('same service type keeps the same color across participants', () => {
  const colorSource = read('booking/service-type-color.js');
  const context = { window: {} };
  vm.runInNewContext(colorSource, context);
  const colorMap = context.window.BookingServiceTypeColor;

  assert.equal(colorMap.slot('按摩'), colorMap.slot('按摩'));
  assert.equal(colorMap.slot('按摩'), colorMap.slot(' 按摩 '));
  assert.equal(colorMap.normalize(' 按摩 '), '按摩');
});

test('legacy formatter is gone and current renderer syntax is valid', () => {
  assert.equal(fs.existsSync(path.join(root, 'booking/member-booking-format.js')), false);
  for (const relativePath of ['booking/app.js', 'booking/group-booking.js', 'booking/service-type-color.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, relativePath)], { stdio: 'pipe' });
  }
});
