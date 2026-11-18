const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const direct = { bookingId: 'no-booking', title: '不綁定預約，直接使用票券' };
const eligible = { bookingId: 'a4b630a6-e54a-48dc-bc9b-602bb35e8e5e', bookingDate: '2026-11-20', startTime: '10:00', title: '按摩' };

function loadChoice() {
  const window = {};
  const document = {
    createElement(tag) {
      return {
        tag, children: [], value: '', textContent: '',
        append(...items) { this.children.push(...items); },
        replaceChildren(...items) { this.children = items; },
        setAttribute() {}, addEventListener() {},
      };
    },
  };
  vm.runInNewContext(read('ticket-booking-choice.js'), { window, document });
  return { choice: window.TicketBookingChoice, document };
}

test('AC-001: amount-restricted event tickets require an eligible booking, never a direct-use choice', () => {
  const { choice } = loadChoice();
  for (const mode of ['total', 'selected_services']) {
    const result = choice.eventOptions({ minBookingAmountMode: mode, minBookingAmount: 500 }, [direct, eligible]);
    assert.equal(result.requiresBooking, true);
    assert.deepEqual(Array.from(result.bookings, item => item.bookingId), [eligible.bookingId]);
    assert.equal(choice.eventOptions({ minBookingAmountMode: mode }, [direct]).bookings.length, 0,
      'missing eligible bookings must not fall back to unbound redemption');
  }
});

test('AC-002: required services and service groups retain the confirmed-booking selector', () => {
  const { choice } = loadChoice();
  for (const ticket of [
    { requiredServiceIds: ['service-one'] },
    { requiredServiceGroups: [['service-one', 'service-two']] },
    { requiredServiceRequirementLabel: '需預約指定項目' },
  ]) {
    const result = choice.eventOptions(ticket, [direct, eligible]);
    assert.equal(result.requiresBooking, true);
    assert.deepEqual(Array.from(result.bookings, item => item.bookingId), [eligible.bookingId]);
  }
});

test('AC-003: fully unrestricted event ticket skips the booking panel and selects direct use implicitly', () => {
  const { choice } = loadChoice();
  const result = choice.eventOptions({ minBookingAmountMode: 'none', requiredServiceIds: [], requiredServiceGroups: [] }, [eligible, direct]);
  assert.equal(result.requiresBooking, false);
  assert.deepEqual(Array.from(result.bookings, item => item.bookingId), ['no-booking']);
  const host = { children: [], replaceChildren(...nodes) { this.children = nodes; } };
  choice.mount(host, result.bookings);
  assert.equal(choice.selected(host), 'no-booking');
  const app = read('event/app.js');
  assert.match(app, /bookingChoice\.hidden\s*=\s*transferMode\s*\|\|\s*history\s*\|\|\s*!claim\s*\|\|\s*reserved\s*\|\|\s*!choiceMode\.requiresBooking/);
  assert.match(app, /if \(transferMode\) bookingChoice\.replaceChildren\(\)/);
  assert.match(app, /else window\.TicketBookingChoice\?\.mount\(bookingChoice,\s*choiceMode\.bookings/);
  assert.match(app, /TicketBookingChoice\?\.selected\(bookingChoice\)/);
  assert.match(app, /確認後可直接使用並核銷/);
});

test('AC-004: rule metadata that indicates a restriction fails closed; no eligible direct use stays disabled', () => {
  const { choice } = loadChoice();
  for (const ticket of [
    { minBookingAmountMode: 'invalid' },
    { minBookingAmountMode: 'none', minBookingAmount: 150 },
    { minBookingAmountLabel: '金額條件資料異常' },
  ]) {
    const result = choice.eventOptions(ticket, [direct]);
    assert.equal(result.requiresBooking, true);
    assert.equal(result.bookings.length, 0);
  }
  assert.equal(choice.eventOptions({}, [eligible]).bookings.length, 0);
});

test('AC-005: point-card booking intersection and unrestricted direct option are unchanged', () => {
  const { choice } = loadChoice();
  const both = choice.common([
    { eligibleBookings: [direct, eligible] },
    { eligibleBookings: [direct] },
  ]);
  assert.deepEqual(Array.from(both, item => item.bookingId), ['no-booking']);
  assert.equal(choice.eventOptions({ minBookingAmountMode: 'none' }, [direct]).requiresBooking, false);
});

test('AC-006: migration guards direct-use listing and server-side redemption, including future tenants', () => {
  const sql = read('supabase/migrations/20261118094500_event_ticket_amount_requires_booking.sql');
  assert.match(sql, /member_ticket_booking_options/);
  assert.match(sql, /redeem_member_tickets_for_booking_request/);
  assert.match(sql, /booking_ticket_meets_amount\(null::uuid,p_member_id,t\.kind,t\.ref\)/);
  assert.match(sql, /p_booking_id is null and p_kind=''event''/);
  assert.match(sql, /BOOKING_BENEFIT_AMOUNT_REQUIRED/);
  assert.match(sql, /platform_private\.business_templates/);
  assert.doesNotMatch(sql, /update\s+.*event_ticket_claims\s+set/i);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/gim,
    'migration must not take over transactions managed by scripts/supabase-release.mjs');
  const html = read('event/index.html');
  assert.match(html, /ticket-booking-choice\.js\?v=[^"]*event-booking-20261118-1/);
  assert.match(html, /app\.js\?v=[^"]*event-booking-20261118-1/);
});


test('AC-007: actual deployment release plan accepts the new SQL migration', async () => {
  const { pathToFileURL } = require('node:url');
  const release = await import(pathToFileURL(path.resolve(root, '../scripts/supabase-release.mjs')).href);
  const plan = release.loadReleasePlan(path.resolve(root, '..'));
  assert.equal(plan.migrations.filter(item =>
    item.filename === '20261118094500_event_ticket_amount_requires_booking.sql').length, 1);
});
