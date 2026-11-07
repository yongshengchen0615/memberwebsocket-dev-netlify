'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual shipped calendar script, exposing its internal actions only in this test VM.
function load() {
  const filename = path.resolve(__dirname, '../booking/calendar-flow.js');
  const source = fs.readFileSync(filename, 'utf8');
  assert.match(source, /\}\)\(\);\s*$/);
  const instrumented = source.replace(/\}\)\(\);\s*$/, 'window.__test = { state, els, bookingBlockReason, phoneBookingBlockReason, updateDayAction, renderCalendar };\n})();');
  const win = { addEventListener() {}, BookingSystem: { formatDate: value => value } };
  const context = { window: win, document: {}, HTMLElement: class {} };
  vm.runInNewContext(instrumented, context, { filename });
  const h = win.__test;
  Object.assign(h.state, {
    today: '2026-11-07',
    minimumDate: '2026-11-09',
    maximumDate: '2026-12-07',
    minAdvanceDays: 2,
    maxAdvanceDays: 30,
    phoneBookingNumber: '06-1234567',
    month: '2026-11',
  });
  h.els.startDayBookingButton = { disabled: false };
  h.els.bookingDayHint = { textContent: '' };
  h.els.bookingPhoneFallback = { hidden: true };
  h.els.bookingPhoneDial = { href: '', textContent: '', setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } };
  return h;
}

function action(h, date) {
  h.state.historyDate = date;
  h.updateDayAction();
  return {
    onlineDisabled: h.els.startDayBookingButton.disabled,
    phoneHidden: h.els.bookingPhoneFallback.hidden,
    href: h.els.bookingPhoneDial.href,
    dialLabel: h.els.bookingPhoneDial.textContent,
    hint: h.els.bookingDayHint.textContent,
  };
}

test('AC-001: lead-time is online-only; today and tomorrow may be booked by telephone', () => {
  const h = load();
  for (const date of ['2026-11-07', '2026-11-08']) {
    const result = action(h, date);
    assert.equal(result.onlineDisabled, true, date);
    assert.equal(result.phoneHidden, false, date);
    assert.equal(result.href, 'tel:061234567');
    assert.equal(result.dialLabel, '撥打店家電話＋06-1234567');
    assert.match(result.hint, /提前 2 天/);
  }
  for (const date of ['2026-11-09', '2026-12-07']) {
    const result = action(h, date);
    assert.equal(result.onlineDisabled, false, date);
    assert.equal(result.phoneHidden, false, date);
  }
});

test('AC-002: past, holiday and beyond merchant horizon deny online AND telephone', () => {
  const h = load();
  h.state.holidaysByDate.set('2026-11-10', [{ title: '店休' }]);
  for (const date of ['2026-11-06', '2026-11-10', '2026-12-08']) {
    const result = action(h, date);
    assert.equal(result.onlineDisabled, true, date);
    assert.equal(result.phoneHidden, true, date);
    assert.equal(result.href, undefined, date);
    assert.equal(result.dialLabel, '撥打店家電話', date);
  }
  assert.match(action(h, '2026-12-08').hint, /超過可預約範圍/);
});

test('AC-003: invalid or missing number must not offer a callable link', () => {
  const h = load();
  for (const phone of ['', 'javascript:alert(1)', '123']) {
    h.state.phoneBookingNumber = phone;
    const result = action(h, '2026-11-08');
    assert.equal(result.phoneHidden, true);
    assert.equal(result.href, undefined);
    assert.equal(result.dialLabel, '撥打店家電話');
  }
});

function element(tag) {
  const el = {
    tag, children: [], dataset: {}, attributes: {},
    classList: { values: new Set(), add(value) { this.values.add(value); } },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    addEventListener() {},
  };
  return el;
}

test('AC-005: phone number changes update the button and revocation removes stale text', () => {
  const h = load();
  action(h, '2026-11-09');
  h.state.phoneBookingNumber = '+886-6-9876543';
  const changed = action(h, '2026-11-09');
  assert.equal(changed.dialLabel, '撥打店家電話＋+886-6-9876543');
  assert.equal(changed.href, 'tel:+88669876543');
  h.state.phoneBookingNumber = '';
  const disabled = action(h, '2026-11-09');
  assert.equal(disabled.phoneHidden, true);
  assert.equal(disabled.href, undefined);
  assert.equal(disabled.dialLabel, '撥打店家電話');
});

test('AC-004: calendar telephone badge follows phone range, not online lead time', () => {
  const h = load();
  const doc = { createElement: element };
  // The calendar factory is defined inside the VM, so supply its document there by
  // updating the object referenced by the VM through the original global fixture.
  // Render tests use the same production script, never a reimplemented date calculation.
  const src = fs.readFileSync(path.resolve(__dirname, '../booking/calendar-flow.js'), 'utf8');
  const instrumented = src.replace(/\}\)\(\);\s*$/, 'window.__test = { state, els, renderCalendar };\n})();');
  const win = { addEventListener() {}, BookingSystem: { formatDate: value => value } };
  const context = { window: win, document: doc, HTMLElement: class {} };
  vm.runInNewContext(instrumented, context);
  const x = win.__test;
  Object.assign(x.state, { today: '2026-11-07', minimumDate: '2026-11-09', maximumDate: '2026-12-07', minAdvanceDays: 2, phoneBookingNumber: '06-1234567', month: '2026-11' });
  x.els.calendarGrid = element('div');
  x.els.calendarGrid.replaceChildren = function () { this.children = []; };
  x.els.calendarMonthLabel = element('span');
  x.renderCalendar();
  function day(date) { return x.els.calendarGrid.children.find(el => el.dataset.date === date); }
  const badge = el => el.children.some(child => child.className === 'calendar-phone-badge');
  assert.equal(badge(day('2026-11-07')), true);
  assert.equal(badge(day('2026-11-08')), true);
  assert.equal(badge(day('2026-11-09')), true);
  assert.equal(badge(day('2026-11-06')), false);
  x.state.month = '2026-12';
  x.renderCalendar();
  assert.equal(badge(day('2026-12-07')), true);
  assert.equal(badge(day('2026-12-08')), false);
});
