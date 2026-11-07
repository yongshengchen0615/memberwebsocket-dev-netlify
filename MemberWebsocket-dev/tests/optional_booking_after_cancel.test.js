const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('optional booking patch removes the service-rule gate only for direct use', () => {
  const migration = read('supabase/migrations/20261015104000_optional_booking_ticket_after_cancel.sql');
  assert.match(migration, /member_ticket_booking_options\(uuid\)/);
  assert.match(migration, /ticket_has_service_requirement\(p_member_id,t\.kind,t\.ref\)/);
  assert.match(migration, /replace\(v_definition, v_old, 'if not exists'\)/);
  assert.match(migration, /p_booking_id is null and public\.ticket_has_service_requirement/);
  assert.match(migration, /execute replace\(v_definition, v_old, ''\)/);
  assert.match(migration, /OPTIONAL_BOOKING_OPTIONS_PATCH_SOURCE_CHANGED/);
  assert.match(migration, /OPTIONAL_BOOKING_REDEMPTION_PATCH_SOURCE_CHANGED/);
  assert.match(migration, /from public, anon, authenticated/);
  assert.match(migration, /to service_role/);
});

test('server continues verifying booking ownership, selected services and pending reservations', () => {
  const source = read('supabase/migrations/20261006023020_booking_ticket_usage_consistency.sql');
  assert.match(source, /BOOKING_NOT_OWNED/);
  assert.match(source, /BOOKING_BENEFIT_RESERVED/);
  assert.match(source, /booking_ticket_matches_services\(p_booking_id,v_member\.id,p_kind,v_ref\)/);
  assert.match(source, /BOOKING_TICKET_CONFIRMATION_REQUIRED/);
  const migration = read('supabase/migrations/20261015104000_optional_booking_ticket_after_cancel.sql');
  assert.doesNotMatch(migration, /replace\(v_definition,.*BOOKING_BENEFIT_RESERVED/);
});

test('point bootstrap loads eligible bookings after new point tickets are issued', () => {
  const source = read('supabase/functions/api/index.ts');
  const start = source.indexOf('async function pointBootstrap(');
  const end = source.indexOf('async function eventBootstrap(', start);
  assert.ok(start >= 0 && end > start);
  const bootstrap = source.slice(start, end);
  const issue = bootstrap.indexOf('issue_eligible_point_tickets_for_member');
  const options = bootstrap.indexOf('supabase.rpc("member_ticket_booking_options"');
  assert.ok(issue >= 0 && options > issue, 'new point tickets must exist before eligibility evaluation');
  assert.match(bootstrap, /if \(bookingOptions\.error\) throw mapDatabaseError/);
});

test('post-cancellation eligible ticket supports no-booking selection, but unavailable tickets do not', () => {
  const context = { window: {} };
  vm.runInNewContext(read('ticket-booking-choice.js'), context);
  const { common } = context.window.TicketBookingChoice;
  const direct = { bookingId: 'no-booking', title: '不綁定預約，直接使用票券' };
  const matching = common([{ eligibleBookings: [direct] }, { eligibleBookings: [direct, { bookingId: 'other' }] }]);
  assert.deepEqual(Array.from(matching, value => value.bookingId), ['no-booking']);
  assert.equal(common([{ eligibleBookings: [] }]).length, 0);
  assert.match(read('supabase/functions/_shared/booking-ticket-usage.ts'), /id === 'no-booking'\) return null/);
  assert.match(read('points/pointcard-ticket-overview.js'), /Boolean\(ticket\?\.eligibleBookings\?\.length\)/);
});
