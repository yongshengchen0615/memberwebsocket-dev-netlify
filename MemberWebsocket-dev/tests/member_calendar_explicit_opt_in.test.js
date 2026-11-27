const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/member-calendar-api/index.ts'), 'utf8');

// Exercise the real member-calendar response projection without invoking LINE or a
// live Supabase project. The test deliberately includes the ticket fallback path.
function projectCalendarRows(calendarRows = [], tickets = [], profile = { tierKey: 'general' }) {
  const start = source.indexOf('    const memberBirthdayMonth = birthdayMonth(profile.birthday);');
  const end = source.indexOf('    const policy=await loadVisibilityPolicy(db);', start);
  assert.ok(start >= 0 && end > start, 'member API calendar projection is present');
  const projection = source.slice(start, end)
    .replace(/:\s*any\b/g, '')
    .replace(/:\s*CalendarItem(?:\[\])?/g, '')
    .replace(/new Set<string>\(\)/g, 'new Set()')
    .replace(/new Map<string,string>\(/g, 'new Map(');
  const run = new Function(
    'result', 'eventTicketsResult', 'bookingServicesResult', 'profile', 'birthdayMonth', 'asText',
    'calendarClient', 'decorateTierEligibility', 'activityUsageLabels', 'parseIsoDate', 'URL',
    projection + '\nreturn { items, ongoingTickets };'
  );
  const asText = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
  const calendarClient = (row) => ({
    calendarItemId: row.calendar_item_id, itemType: row.item_type,
    title: row.title, status: row.status, startsOn: row.starts_on,
    endsOn: row.ends_on || '', allowedTierKeys: row.allowed_tier_keys || [],
    linkUrl: row.link_url || '', visibilityPolicy: row.visibility_policy || 'eligible_only'
  });
  const decorateTierEligibility = (item) => ({ ...item, tierEligible: true });
  const parseIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(String(value) + 'T00:00:00Z') : null;
  return run({ data: calendarRows }, { data: tickets }, { data: [] }, profile,
    () => 0, asText, calendarClient, decorateTierEligibility, () => [], parseIsoDate, URL);
}

const activeTicket = {
  id: '00000000-0000-4000-8000-000000000001',
  event_ticket_id: 'QA-TICKET-1', title: '尚未勾選的活動券',
  description: '只存在活動票券', starts_on: '2026-12-01',
  ends_on: '2026-12-15', status: 'active',
  accent: '#123456', allowed_tier_keys: ['general'], visibility_policy: 'eligible_only'
};

test('AC-001: active dated ticket without an explicit calendar opt-in does not appear', () => {
  const result = projectCalendarRows([], [activeTicket]);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.ongoingTickets, []);
});

test('AC-002: active relative-validity ticket without opt-in is not shown as ongoing', () => {
  const result = projectCalendarRows([], [{
    ...activeTicket, event_ticket_id: 'QA-TICKET-RELATIVE',
    starts_on: null, ends_on: null, validity_mode: 'relative'
  }]);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.ongoingTickets, []);
});

test('AC-003: only opted-in ticket gets an event item; it retains the linked tier policy', () => {
  const rows = [{
    calendar_item_id: 'QA-CALENDAR-1',
    title: '已勾選活動', item_type: 'event', status: 'active',
    starts_on: '2026-12-01', ends_on: '2026-12-15',
    link_url: 'https://test.example/event/?source=event-ticket-calendar&eventTicketId=QA-TICKET-1',
    allowed_tier_keys: ['gold'], visibility_policy: 'eligible_only'
  }];
  const result = projectCalendarRows(rows, [
    { ...activeTicket, title: '已勾選活動', allowed_tier_keys: ['silver'], visibility_policy: 'higher_preview' },
    { ...activeTicket, event_ticket_id: 'QA-NOT-OPTED-IN', id: '00000000-0000-4000-8000-000000000002' }
  ]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].calendarItemId, 'QA-CALENDAR-1');
  assert.deepEqual(result.items[0].allowedTierKeys, ['silver']);
  assert.equal(result.items[0].visibilityPolicy, 'higher_preview');
});

test('AC-004: ordinary calendar event and holiday remain without exposing unlinked tickets', () => {
  const rows = [
    { calendar_item_id: 'QA-EVENT', title: '會員活動', item_type: 'event', status: 'active', starts_on: '2026-12-01' },
    { calendar_item_id: 'QA-HOLIDAY', title: '技師休假', item_type: 'holiday', status: 'active', starts_on: '2026-12-02' }
  ];
  const result = projectCalendarRows(rows, [activeTicket]);
  assert.deepEqual(result.items.map((item) => item.calendarItemId), ['QA-EVENT', 'QA-HOLIDAY']);
  assert.deepEqual(result.ongoingTickets, []);
});

test('AC-005: two explicitly linked tickets display by UUID and code, unrelated active ticket stays hidden', () => {
  const rows = [
    {
      calendar_item_id: 'QA-CALENDAR-UUID',
      item_type: 'event', title: 'UUID 關聯活動',
      status: 'active', starts_on: '2026-12-03',
      source_event_ticket_id: activeTicket.id, allowed_tier_keys: ['general']
    },
    {
      calendar_item_id: 'QA-CALENDAR-CODE',
      item_type: 'event', title: '代號關聯活動',
      status: 'active', starts_on: '2026-12-04',
      link_url: 'https://test.example/event/?source=event-ticket-calendar&eventTicketId=QA-TICKET-2',
      allowed_tier_keys: ['general']
    }
  ];
  const result = projectCalendarRows(rows, [
    activeTicket,
    { ...activeTicket, id: '00000000-0000-4000-8000-000000000002', event_ticket_id: 'QA-TICKET-2' },
    { ...activeTicket, id: '00000000-0000-4000-8000-000000000003', event_ticket_id: 'QA-TICKET-HIDDEN' }
  ]);
  assert.deepEqual(result.items.map((item) => item.calendarItemId), ['QA-CALENDAR-UUID', 'QA-CALENDAR-CODE']);
  assert.deepEqual(result.ongoingTickets, []);
});
