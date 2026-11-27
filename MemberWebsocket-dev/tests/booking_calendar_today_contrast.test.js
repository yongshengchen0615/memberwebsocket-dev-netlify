const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync('MemberWebsocket-dev/' + path, 'utf8');
const styles = read('booking/calendar-holiday-theme.css');
const calendar = read('booking/calendar-flow.css');
const page = read('booking/index.html');

function rule(selector) {
  const start = styles.indexOf(selector + ' {');
  assert.notEqual(start, -1, 'CSS rule exists: ' + selector);
  const end = styles.indexOf('}', start);
  assert.ok(end > start, 'CSS rule closes: ' + selector);
  return styles.slice(start, end);
}

test('AC-TODAY-001: today is blue while holidays remain a distinct red', () => {
  const today = rule('#calendarGrid .calendar-day.today:not(.holiday-disabled)');
  const holiday = rule('#calendarGrid .calendar-day.holiday-disabled');
  assert.match(today, /border: 2px solid #1467af/);
  assert.match(today, /background: #e8f3ff/);
  assert.match(holiday, /background: #ffeddf/);
  assert.match(holiday, /border: 2px solid #b6462f/);
  assert.notEqual('#1467af', '#b6462f');
});

test('AC-TODAY-002: blue date badge provides a non-background distinguishing cue', () => {
  const number = rule('#calendarGrid .calendar-day.today .calendar-day-number');
  assert.match(number, /background: #1467af/);
  assert.match(number, /color: #ffffff/);
  assert.match(number, /border-radius: 999px/);
  assert.match(rule('#bookingView .calendar-legend .today-dot'), /background: #1467af/);
  assert.match(calendar, /\.calendar-legend \.holiday-dot\{background:#df6b4d\}/);
});

test('AC-TODAY-003: when today is a holiday, red closure and blue today markers both remain', () => {
  const both = rule('#calendarGrid .calendar-day.holiday-disabled.today');
  assert.match(both, /border-color: #b6462f/);
  assert.match(rule('#calendarGrid .calendar-day.holiday-disabled.today::after'), /border: 2px dashed #1467af/);
  assert.match(rule('#calendarGrid .calendar-day.today .calendar-day-number'), /background: #1467af/);
  assert.match(rule('#calendarGrid .calendar-day.holiday-disabled.today .calendar-day-number'), /color: #ffffff/);
  assert.match(rule('html[data-theme="dark"] #calendarGrid .calendar-day.holiday-disabled.today .calendar-day-number'), /color: #09283e/);
  assert.match(styles, /#calendarGrid \.calendar-holiday-label/);
});

test('AC-TODAY-004: dark theme maintains distinct blue and warm-red surfaces', () => {
  const today = rule('html[data-theme="dark"] #calendarGrid .calendar-day.today:not(.holiday-disabled)');
  assert.match(today, /background: #152e4b/);
  assert.match(today, /border-color: #75c8ff/);
  assert.match(rule('html[data-theme="dark"] #calendarGrid .calendar-day.today .calendar-day-number'), /background: #79ccff/);
  assert.match(rule('html[data-theme="dark"] #calendarGrid .calendar-day.holiday-disabled.today::after'), /border-color: #79ccff/);
  assert.match(rule('html[data-theme="dark"] #calendarGrid .calendar-day.holiday-disabled'), /background: #42231e/);
});

test('AC-TODAY-005: selected day stays visibly selected and rules survive narrow phones', () => {
  assert.match(rule('#calendarGrid .calendar-day.today.selected:not(.holiday-disabled)'), /outline: 2px solid #17352e/);
  assert.match(styles, /@media \(max-width: 430px\)/);
  assert.match(rule('#calendarGrid .calendar-day.today .calendar-day-number'), /min-width: 24px/);
});

test('AC-TODAY-006: member booking page cache-busts the changed stylesheet', () => {
  assert.match(page, /calendar-holiday-theme\.css\?v=[^"']+holiday-contrast=20261127-2/);
  assert.match(page, /calendar-flow\.css\?v=/);
});
