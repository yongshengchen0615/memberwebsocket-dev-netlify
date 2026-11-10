const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const client = fs.readFileSync('MemberWebsocket-dev/calendar/app.js', 'utf8');
const api = fs.readFileSync('MemberWebsocket-dev/supabase/functions/member-calendar-api/index.ts', 'utf8');

// Exercise the actual source functions without network access or a live member account.
function extractFunction(source, name, indent = '') {
  const marker = indent + 'function ' + name + '(';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, name + ' exists');
  const closing = '\n' + indent + '}';
  const end = source.indexOf(closing, start);
  assert.notEqual(end, -1, name + ' closes');
  return source.slice(start, end + closing.length);
}

const selectClient = new Function(
  extractFunction(client, 'itemOnDate', '  ') + '\n' +
  extractFunction(client, 'visibleCalendarItemsOnDate', '  ') +
  '\nreturn visibleCalendarItemsOnDate;'
)();

const parseDate = extractFunction(api, 'parseIsoDate')
  .replace('value: unknown', 'value').replace('): Date | null', ')');
const toDate = extractFunction(api, 'toIsoDate')
  .replace('date: Date', 'date').replace('): string', ')');
const isTicket = extractFunction(api, 'isManagedEventTicketCalendarItem')
  .replace('item: CalendarItem', 'item').replace('): boolean', ')');
const holidays = extractFunction(api, 'holidayDateSet')
  .replace('items: CalendarItem[]', 'items').replace('): Set<string>', ')')
  .replace('new Set<string>()', 'new Set()');
const split = extractFunction(api, 'splitManagedEventAroundHolidays')
  .replace('item: CalendarItem, holidays: Set<string>', 'item, holidays')
  .replace('): CalendarItem[]', ')')
  .replace('const segments: CalendarItem[] = [];', 'const segments = [];');

const server = new Function(
  'const asText = (value, max = 1000) => String(value ?? "").trim().slice(0, max);\n' +
  parseDate + '\n' + toDate + '\n' + isTicket + '\n' + holidays + '\n' + split +
  '\nreturn { holidayDateSet, splitManagedEventAroundHolidays };'
)();

const holiday = { calendarItemId: 'h1', itemType: 'holiday', status: 'active', startsOn: '2026-11-11', endsOn: '2026-11-12', title: '店休' };
const event = { calendarItemId: 'e1', itemType: 'event', startsOn: '2026-11-10', endsOn: '2026-11-14', title: '會員活動' };
const ticket = { calendarItemId: 't1', itemType: 'event', startsOn: '2026-11-11', endsOn: '2026-11-13', title: '活動票券', linkUrl: 'https://example.org/event/?source=event-ticket-calendar&eventTicketId=t1' };

test('AC-001: holidays take precedence over both activities and ticket calendar entries', () => {
  assert.deepEqual(selectClient([event, ticket, holiday], '2026-11-11'), [holiday]);
  assert.deepEqual(selectClient([event, ticket, holiday], '2026-11-12'), [holiday]);
  assert.deepEqual(selectClient([event, ticket, holiday], '2026-11-13'), [event, ticket]);
  assert.deepEqual(selectClient([event, ticket, holiday], '2026-11-10'), [event]);
});

test('AC-002: holiday dates are consistent in the grid, date details, and month summary', () => {
  assert.match(client, /const entries = visibleCalendarItemsOnDate\(state\.items, isoDate\)/);
  assert.match(client, /const items = visibleCalendarItemsOnDate\(state\.items, isoDate\)/);
  assert.match(client, /const entries = visibleCalendarItemsOnDate\(state\.items, toIsoDate\(day\)\)/);
  assert.match(client, /displayedDates\.flat\(\)\.filter\(\(item\) => item\.itemType === 'event'\)/);
});

test('AC-003: the API removes closed days but preserves open segments of ordinary activities', () => {
  const days = server.holidayDateSet([holiday]);
  const segments = server.splitManagedEventAroundHolidays(event, days);
  assert.deepEqual(segments.map(({ startsOn, endsOn }) => [startsOn, endsOn]), [
    ['2026-11-10', ''],
    ['2026-11-13', '2026-11-14']
  ]);
  assert.ok(segments.every((item) => item.calendarItemId === event.calendarItemId));
});

test('AC-004: managed ticket calendar entries obey the same rule and keep their source ID', () => {
  const segments = server.splitManagedEventAroundHolidays(ticket, server.holidayDateSet([holiday]));
  assert.deepEqual(segments.map(({ startsOn, endsOn }) => [startsOn, endsOn]), [['2026-11-13', '']]);
  assert.equal(segments[0].calendarDisplaySourceId, 't1');
  assert.equal(server.splitManagedEventAroundHolidays({ ...ticket, startsOn: '2026-11-11', endsOn: '2026-11-12' }, new Set(['2026-11-11', '2026-11-12'])).length, 0);
});

test('AC-005: inactive holidays do not hide events; holidays themselves remain intact', () => {
  const inactive = { ...holiday, status: 'inactive' };
  assert.deepEqual([...server.holidayDateSet([inactive])], []);
  assert.deepEqual(selectClient([event, inactive], '2026-11-11'), [event, inactive]);
  assert.deepEqual(server.splitManagedEventAroundHolidays(holiday, new Set(['2026-11-11'])), [holiday]);
});

test('AC-006: API date details use the same filtered holiday-priority snapshot', () => {
  assert.match(api, /items = applyCalendarDisplayRules\(items\)/);
  assert.match(api, /items = items\.filter\(\(item\) => includesDate\(item, date\)\)/);
  assert.match(api, /if \(String\(item\.itemType \|\| ""\) !== "event"\) return \[item\]/);
});
