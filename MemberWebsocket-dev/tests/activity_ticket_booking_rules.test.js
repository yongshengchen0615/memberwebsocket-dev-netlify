const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('AC-001: event-ticket editor saves and restores a booking party-size range', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  for (const name of ['eventTicketMinBookingPartySize', 'eventTicketMaxBookingPartySize']) {
    assert.match(html, new RegExp('id="' + name + '"'));
    assert.match(app, new RegExp(name));
  }
  assert.match(app, /minBookingPartySize:\s*Number\(/);
  assert.match(app, /maxBookingPartySize:\s*Number\(/);
  assert.match(app, /result\.eventTicket\.minBookingPartySize/);
});

test('AC-002: ticket party-size contract is validated server-side and exposed to members', () => {
  const api = read('supabase/functions/api/index.ts');
  assert.match(api, /INVALID_BOOKING_PARTY_SIZE_RULE/);
  assert.match(api, /min_booking_party_size:\s*minBookingPartySize/);
  assert.match(api, /max_booking_party_size:\s*maxBookingPartySize/);
  assert.match(api, /minBookingPartySize:\s*Number\(row\.min_booking_party_size/);
  assert.match(api, /maxBookingPartySize:\s*Number\(row\.max_booking_party_size/);
  assert.match(api, /minBookingPartyLabel:/);
});

test('AC-003: ticket party-size rule is enforced at the existing transactional booking eligibility boundary', () => {
  const sql = read('supabase/migrations/20261127160000_activity_ticket_booking_rules.sql');
  assert.match(sql, /booking_ticket_meets_party_size/);
  assert.match(sql, /booking_ticket_meets_amount/);
  assert.match(sql, /b\.member_id=p_member_id/);
  assert.match(sql, /b\.party_size/);
  assert.match(sql, /platform_private\.business_templates/);
  assert.match(sql, /business_\[0-9a-f\]/);
  assert.match(sql, /revoke all on function/i);
});

test('AC-004: member activities share configurable reservation item, amount and party rules', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const api = read('supabase/functions/api/index.ts');
  for (const id of ['calendarRequiredServiceIds', 'calendarRequiredServiceMatchMode',
    'calendarRequiredServiceGroups', 'calendarMinBookingAmountMode', 'calendarMinBookingAmount',
    'calendarMinBookingServiceIds', 'calendarMinBookingPartySize', 'calendarMaxBookingPartySize']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(app, /usageConditions:[^\n]*collectCalendarUsageConditions\(/);
  assert.match(api, /normalizeCalendarUsageConditions/);
  assert.match(api, /usageConditions:\s*row\.usage_conditions/);
});

test('AC-005: member activity eligibility must be decided on server and displayed in the calendar', () => {
  const server = read('supabase/functions/member-calendar-api/index.ts');
  const ui = read('calendar/app.js');
  assert.match(server, /usageEligible/);
  assert.match(server, /usageConditions/);
  assert.match(server, /booking_items/);
  assert.match(server, /member_id/);
  assert.match(ui, /usageEligible === false/);
  assert.match(ui, /usageConditionLabel/);
});

test('AC-006: database schema guards activity-rule shape and provisions future tenants', () => {
  const sql = read('supabase/migrations/20261127160000_activity_ticket_booking_rules.sql');
  assert.match(sql, /calendar_usage_conditions_valid/);
  assert.match(sql, /usage_conditions jsonb/);
  assert.match(sql, /apply_calendar_batch/);
  assert.match(sql, /platform_private\.business_templates/);
});
