const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const scope = require('../admin/calendar-scope-rules.js');

const fileAt = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const adminHtml = fileAt('admin/index.html');
const adminApp = fileAt('admin/app.js');
const memberHtml = fileAt('calendar/index.html');
const memberApp = fileAt('calendar/app.js');
const calendarApi = fileAt('supabase/functions/member-calendar-api/index.ts');

const ticket = { eventTicketId: 'EVT-10', title: '活動票券', startsOn: '2026-11-24', endsOn: '2026-11-30' };
const booking = { bookingId: 'B-1', bookingDate: '2026-11-25', startTime: '13:00' };
const activity = { calendarItemId: 'A-1', title: '會員活動', itemType: 'event', startsOn: '2026-11-25' };
const holiday = { calendarItemId: 'H-1', title: '休假', itemType: 'holiday', startsOn: '2026-11-26' };
const syncedTicket = { calendarItemId: 'T-1', itemType: 'event', startsOn: '2026-11-25', linkUrl: 'https://example.org/?source=event-ticket-calendar&eventTicketId=EVT-10' };

test('AC-001: each admin calendar accepts only its own record category', () => {
  assert.deepEqual([ticket, booking, activity, holiday, syncedTicket].filter(item => scope.belongsToScope('ticket', item)), [ticket]);
  assert.deepEqual([ticket, booking, activity, holiday, syncedTicket].filter(item => scope.belongsToScope('booking', item)), [booking]);
  assert.deepEqual([ticket, booking, activity, holiday, syncedTicket].filter(item => scope.belongsToScope('activity', item)), [activity]);
  assert.deepEqual([ticket, booking, activity, holiday, syncedTicket].filter(item => scope.belongsToScope('holiday', item)), [holiday]);
  assert.equal(scope.belongsToScope('unknown', ticket), false);
});

test('AC-002: ticket-linked calendar items cannot appear in member activities', () => {
  assert.equal(scope.isTicketCalendarEntry(syncedTicket), true);
  assert.equal(scope.belongsToScope('activity', { ...syncedTicket, sourceEventTicketId: 'uuid' }), false);
  assert.equal(scope.belongsToScope('activity', { ...activity, linkUrl: 'https://example.org/' }), true);
});

test('AC-003: strict calendar date handling covers invalid dates and inclusive range', () => {
  assert.equal(scope.validIsoDate('2026-02-29'), false);
  assert.equal(scope.validIsoDate('2028-02-29'), true);
  assert.equal(scope.validIsoDate('2026-11-24T00:00:00Z'), false);
  assert.equal(scope.occursOn(ticket, '2026-11-24'), true);
  assert.equal(scope.occursOn(ticket, '2026-11-30'), true);
  assert.equal(scope.occursOn(ticket, '2026-12-01'), false);
  assert.equal(scope.occursOn(booking, '2026-11-25'), true);
  assert.equal(scope.occursOn(booking, '2026-11-24'), false);
  assert.equal(scope.occursOn(activity, '2026-11-25'), true);
});

test('AC-004: management tabs each have a separate calendar and activities rename', () => {
  assert.match(adminHtml, /id="eventsTab"[^>]*>活動票券<\/button>/);
  assert.match(adminHtml, /id="calendarTab"[^>]*>會員活動<\/button>/);
  for (const id of ['eventTicketCalendarGrid', 'adminCalendarGrid', 'bookingOverviewCalendarGrid']) {
    // Booking calendar is mounted by the booking module at runtime.
    assert.match(id === 'bookingOverviewCalendarGrid' ? fileAt('admin/booking-panel-core.js') : adminHtml, new RegExp('id="' + id + '"'));
  }
  assert.match(adminApp, /rules\.belongsToScope\('activity', item\)/);
  assert.match(adminApp, /rules\.belongsToScope\(kind, item\)/);
});

test('AC-005: calendar batch UI and bindings are not available', () => {
  assert.doesNotMatch(adminHtml, /id="calendarBatchRows"/);
  assert.doesNotMatch(adminHtml, /class="calendar-batch-editor"/);
  assert.doesNotMatch(adminApp, /els\.calendarBatchRows\.addEventListener/);
  assert.doesNotMatch(adminApp, /els\.saveCalendarBatchButton\.addEventListener/);
  assert.doesNotMatch(adminApp, /els\.adminCalendarGrid\.addEventListener\('change'/);
});

test('AC-006: tapping a calendar date begins a new record on its respective editor', () => {
  assert.match(adminApp, /ticketDate\.dataset\.ticketCalendarDate/);
  assert.match(adminApp, /els\.eventTicketStartsOn\.value = date/);
  assert.match(adminApp, /openEditorModal\('eventTicket', ticketDate\)/);
  assert.match(adminApp, /els\.calendarItemStartsOn\.value = dateValue/);
  assert.match(adminApp, /openEditorModal\('calendar', opener\)/);
});

test('AC-007: member calendar reads saved activities; ticket metadata only enriches linked activities', () => {
  assert.match(memberHtml, /<h1>營運日曆<\/h1>/);
  assert.match(calendarApi, /db\.from\("calendar_items"\)/);
  assert.match(calendarApi, /db\.from\("event_tickets"\)/);
  assert.match(calendarApi, /\.eq\("status", "active"\)/);
  assert.match(calendarApi, /let items = calendarEntries\.map\(/);
  assert.match(calendarApi, /const eventByUuid = new Map/);
  assert.match(calendarApi, /const eventByCode = new Map/);
  assert.doesNotMatch(calendarApi, /virtualTicketItems|synchronizedTicketUuids|synchronizedTicketCodes/);
  assert.match(calendarApi, /tierVisibility\(/);
  assert.match(calendarApi, /applyCalendarDisplayRules\(items\)/);
});

test('AC-008: unlinked tickets never appear as ongoing calendar activities, while client contract stays intact', () => {
  assert.match(calendarApi, /const ongoingTickets: CalendarItem\[\] = \[\]/);
  assert.doesNotMatch(calendarApi, /undatedTicketItems|ongoingTickets\.push\(/);
  assert.match(calendarApi, /ongoingTickets:action === "user\.calendar\.bootstrap" \? ongoingTickets : \[\]/);
  assert.match(memberHtml, /id="calendarOngoingTickets"/);
  assert.match(memberApp, /state\.ongoingTickets/);
  assert.match(memberApp, /resolveCalendarLinkForItem/);
  assert.match(memberApp, /url\.searchParams\.set\('eventTicketId', ticketId\)/);
});

test('AC-009: booking calendar cannot display other records and links to booking review', () => {
  assert.match(adminApp, /rows: \[\.\.\.state\.operationalBookings\.filter/);
  assert.match(adminApp, /rules\.belongsToScope\('holiday', item\)/);
  assert.match(adminApp, /kind: 'booking'/);
  assert.match(adminApp, /member-admin:booking-focus/);
  assert.match(adminApp, /data-booking-calendar-id/);
});

test('AC-010: member calendar excludes per-member fixed issues and never invents relative ticket dates', () => {
  // Fixed-ticket allocations can target a specific member or birthday month.
  // Existing targeted calendar rows remain the only authorized display path.
  assert.match(calendarApi, /\.is\("fixed_ticket_template_id", null\)/);
  assert.match(calendarApi, /\.is\("referral_source_event_ticket_id", null\)/);
  assert.match(calendarApi, /let items = calendarEntries\.map\(/);
  assert.doesNotMatch(calendarApi, /synthesized|undatedTicketItems|virtualTicketItems/);
  assert.match(calendarApi, /items=items\.flatMap\(visibility\)/);
});


test('AC-011: holiday management belongs to booking; day tile is an entire clickable target', () => {
  assert.match(adminHtml, /休假日請至「預約」日曆設定/);
  assert.match(adminHtml, /id="newCalendarItemButton"[^>]*>＋ 新增會員活動/);
  assert.match(adminHtml, /class="hidden">類型<select id="calendarItemType"/);
  assert.match(adminApp, /cell\.dataset\.adminCalendarDate = date/);
  assert.match(adminApp, /cell\.dataset\[kind === 'ticket' \? 'ticketCalendarDate' : 'bookingCalendarDate'\] = date/);
  assert.match(adminApp, /openCalendarDateEditor\(date, bookingDate, 'holiday'\)/);
  assert.match(adminApp, /data-booking-calendar-holiday-id/);
  assert.match(adminApp, /renderBookingOverviewCalendar\(\);/);
});

test('AC-012: per-ticket and per-activity policies are distinct, validated and enforced by the server', () => {
  const api = fileAt('supabase/functions/api/index.ts');
  const migration = fileAt('supabase/migrations/20261124234000_per_item_calendar_visibility.sql');
  assert.match(adminHtml, /id="eventTicketVisibilityPolicy"/);
  assert.doesNotMatch(adminHtml, /src="\.\/ticket-visibility\.js/);
  assert.match(adminApp, /id = 'calendarItemVisibilityPolicy'/);
  assert.match(adminApp, /visibilityPolicy: document\.getElementById\('eventTicketVisibilityPolicy'\)\.value/);
  assert.match(adminApp, /visibilityPolicy: els\.calendarItemType\.value === 'event'/);
  assert.match(api, /row\.visibility_policy \|\| 'eligible_only'/);
  assert.match(api, /visibility_policy: visibilityPolicy/);
  assert.match(api, /row\.visibility_policy \|\| visibilityPolicy/);
  assert.match(calendarApi, /item\.visibilityPolicy \|\| policy/);
  assert.match(calendarApi, /visibilityPolicy: linkedTicket\.visibility_policy/);
  assert.match(migration, /ADD CONSTRAINT event_tickets_visibility_policy_allowed/);
  assert.match(migration, /ADD CONSTRAINT calendar_items_visibility_policy_allowed/);
  assert.match(migration, /visibility_policy = coalesce\(nullif\(v_item->>'visibilityPolicy'/);
});

test('AC-013: both calendar themes use shared surfaces, state and readable text tokens', () => {
  const css = fileAt('admin/calendar-workspaces.css');
  for (const token of ['--theme-text', '--theme-surface-raised', '--theme-surface-muted', '--theme-border', '--theme-accent', '--theme-danger-soft']) {
    assert.ok(css.includes('var(' + token + ')'), token);
  }
  assert.match(css, /html\[data-theme\] :is\(#eventsPanel, #calendarPanel, #bookingPanel\)/);
  assert.match(css, /\.admin-calendar-day:is\(:hover, :focus-within\)/);
});
