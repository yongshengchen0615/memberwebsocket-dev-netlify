const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('booking benefit selector is inside appointment form above member note', () => {
  const html = read('booking/index.html');
  const benefit = html.indexOf('id="bookingBenefits"');
  const note = html.indexOf('id="memberNote"');
  const formStart = html.indexOf('id="bookingForm"');
  const formEnd = html.indexOf('</form>', formStart);
  assert.ok(formStart >= 0 && benefit > formStart && benefit < formEnd);
  assert.ok(benefit < note);
  assert.match(html, /本次可使用優惠/);
});

test('member create/update paths persist exact benefit intent', () => {
  const app = read('booking/app.js');
  const bookingApi = read('supabase/functions/booking-api/index.ts');
  const groupApi = read('supabase/functions/booking-group-api/index.ts');
  assert.match(app, /BookingBenefits\?\.selectionPayload/);
  assert.match(app, /benefits:\s*window\.BookingBenefits/);
  assert.match(app, /setSelection\?\.\(booking\.benefits/);
  const reminderAdapter = read('supabase/migrations/20261031090000_member_booking_reminder_choice.sql');
  assert.match(bookingApi, /create_booking_bundle_with_benefits_reminder/);
  assert.match(bookingApi, /update_booking_bundle_with_benefits_reminder/);
  assert.match(groupApi, /create_group_booking_with_benefits_reminder_v2/);
  assert.match(groupApi, /update_group_booking_with_benefits_reminder_v2/);
  for (const canonicalRpc of [
    'create_booking_bundle_with_benefits_request',
    'update_booking_bundle_with_benefits_request',
    'create_group_booking_with_benefits_request_v2',
    'update_group_booking_with_benefits_request_v2',
  ]) {
    assert.ok(reminderAdapter.includes('v_booking := public.' + canonicalRpc + '('),
      'Reminder adapter must retain the existing atomic benefit transaction: ' + canonicalRpc);
  }
  assert.match(groupApi, /booking_benefit_selections/);
});

test('completion uses one database transaction to redeem and settle', () => {
  const migration = read('supabase/migrations/20261002093000_booking_benefit_selection_redemption.sql');
  const adminOps = read('supabase/functions/booking-admin-operations/index.ts');
  assert.match(migration, /create table if not exists public\.booking_benefit_selections/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.booking_benefit_selections from anon, authenticated/);
  assert.match(migration, /public\.redeem_point_tickets\(/);
  assert.match(migration, /public\.redeem_event_tickets_with_location\(/);
  assert.match(migration, /public\.complete_booking_with_rewards_request\(/);
  assert.match(migration, /admin_confirm_booking_receipt_request[\s\S]*complete_booking_with_benefits_request/);
  assert.match(migration, /booking_benefit_selections_terminal_status/);
  assert.match(adminOps, /complete_booking_with_benefits_request/);
  assert.match(adminOps, /EVENT_TICKET_DAILY_LIMIT_REACHED/);
});

test('booking selection does not require GPS while direct ticket redemption still validates location', () => {
  const source = read('supabase/functions/_shared/booking-benefits.ts');
  const migration = read('supabase/migrations/20261012133000_booking_selection_without_gps.sql');
  assert.match(source, /selectable: visibility\.tierEligible && !reservedForOtherBooking && !reservedInSnapshot,/);
  assert.match(source, /selectable: hasTicket && hasEnoughPoints && !reservedForOtherBooking,/);
  assert.match(source, /現場單獨使用需 GPS 定位/);
  assert.doesNotMatch(source, /!offer\.requiresLocation|!reservedForOtherBooking && !locationRestricted/);
  assert.match(migration, /Booking ticket selection expresses reservation intent/);
  assert.match(migration, /if v_event\.requires_location and p_booking_id is null/);
  assert.match(migration, /verify_ticket_redemption_locations/);
});


test('benefit UI uses three grouped entitlement sections and exact selection ids', () => {
  const ui = read('booking/booking-benefits.js');
  const source = read('supabase/functions/_shared/booking-benefits.ts');
  assert.match(ui, /kindOrder = \['calendar', 'points', 'event'\]/);
  assert.match(ui, /booking-benefit-group/);
  assert.match(ui, /dataset\.bookingBenefitKind/);
  assert.match(ui, /dataset\.bookingBenefitId/);
  assert.match(source, /單次預約最多使用 \$\{pointTicketMaxPerRedemption\} 張/);
  assert.match(source, /會員條件：目前會員階級適用/);
});

test('full E2E creates an owned booking benefit fixture and hands it to paired admin redemption', () => {
  const user = read('user-test-control.js');
  const qaApi = read('supabase/functions/user-test-api/index.ts');
  const admin = read('admin/e2e-control.js');
  assert.match(user, /BOOKING_BENEFIT_REDEMPTION_LIFECYCLE/);
  assert.match(user, /bookingBenefitRedemptionLifecycleCase/);
  assert.match(user, /QA HUMAN E2E BENEFIT/);
  assert.match(user, /persistedPending/);
  assert.match(qaApi, /QA-UI-BOOK-PC-/);
  assert.match(qaApi, /QA 預約自動核銷票券/);
  assert.match(qaApi, /issue_eligible_point_tickets/);
  assert.match(admin, /QA HUMAN E2E\(\?: GROUP\| BENEFIT\)/);
  assert.match(admin, /benefitRedemption/);
  assert.match(admin, /pendingBefore/);
  assert.match(admin, /pendingAfter/);
  assert.match(admin, /待核銷優惠/);
});


test('booking activities are display-only while point and event tickets remain selectable', () => {
  const source = read('supabase/functions/_shared/booking-benefits.ts');
  const ui = read('booking/booking-benefits.js');
  const bookingApi = read('supabase/functions/booking-api/index.ts');
  const groupApi = read('supabase/functions/booking-group-api/index.ts');
  assert.match(source, /kind: 'calendar'[\s\S]*selectable: false, selectionId: ''/);
  assert.match(source, /活動資訊僅供預約參考/);
  assert.match(ui, /selectableKinds = new Set\(\['points', 'event'\]\)/);
  assert.match(ui, /活動僅顯示；集點卡票券單次/);
  assert.match(ui, /活動票券每日/);
  assert.match(ui, /if \(item\?\.kind !== 'calendar'\) return ''/);
  assert.doesNotMatch(bookingApi, /\["points","event","calendar"\]\.includes\(kind\)/);
  assert.doesNotMatch(groupApi, /\["points","event","calendar"\]\.includes\(kind\)/);
});


test('booking confirmation shows the exact selected ticket names for single and group bookings', () => {
  const app = read('booking/app.js');
  const group = read('booking/group-booking.js');
  for (const source of [app, group]) {
    assert.match(source, /BookingBenefits\?\.selectionSummary\?\.\(\)/);
    assert.match(source, /本次使用票券/);
    assert.match(source, /集點卡票券/);
    assert.match(source, /活動票券/);
    assert.match(source, /本次未使用票券/);
    assert.match(source, /booking-confirm-ticket-list/);
    assert.match(source, /item\?\.kind === 'points' \|\| item\?\.kind === 'event'/);
  }
});

test('booking point tickets enforce current balance in UI and database', () => {
  const source = read('supabase/functions/_shared/booking-benefits.ts');
  const ui = read('booking/booking-benefits.js');
  const migration = read('supabase/migrations/20261002151000_booking_point_ticket_balance_guard.sql');
  const bookingApi = read('supabase/functions/booking-api/index.ts');
  const groupApi = read('supabase/functions/booking-group-api/index.ts');

  assert.match(source, /from\('point_balances'\)/);
  assert.match(source, /pointBalance/);
  assert.match(source, /pointCost/);
  assert.match(source, /點數不足/);
  assert.match(ui, /selectedPointSpend/);
  assert.match(ui, /pointBudget/);
  assert.match(ui, /spent \+ cost <= balance/);
  assert.match(migration, /POINT_TICKET_INSUFFICIENT_POINTS/);
  assert.match(migration, /before insert on public\.booking_benefit_selections/);
  assert.match(migration, /for update/);
  assert.match(bookingApi, /POINT_TICKET_INSUFFICIENT_POINTS/);
  assert.match(groupApi, /POINT_TICKET_INSUFFICIENT_POINTS/);
  assert.match(groupApi, /POINT_TICKET_SELECTION_LIMIT_EXCEEDED/);
  assert.match(groupApi, /point_card_settings/);
});

test('booking event ticket checkbox can claim and server enforces configured selection cap', () => {
  const source = read('supabase/functions/_shared/booking-benefits.ts');
  const common = read('booking/common.js');
  const ui = read('booking/booking-benefits.js');
  const api = read('supabase/functions/api/index.ts');
  const bookingApi = read('supabase/functions/booking-api/index.ts');
  const groupApi = read('supabase/functions/booking-group-api/index.ts');
  assert.match(source, /claimRequired: visibility\.tierEligible && !offer\.claimed/);
  assert.match(source, /eventTicketMaxPerDay/);
  assert.match(common, /user\.booking\.event-ticket\.claim/);
  assert.match(common, /claimEventTicket/);
  assert.match(ui, /勾選「\$\{title\}」即代表領取此活動票券/);
  assert.match(ui, /selectedEventCount\(\) >= eventTicketMaxPerDay/);
  assert.match(api, /user\.booking\.event-ticket\.claim/);
  assert.match(bookingApi, /validateBookingBenefitSelectionLimit/);
  assert.match(bookingApi, /EVENT_TICKET_SELECTION_LIMIT_EXCEEDED/);
  assert.match(groupApi, /validateBookingBenefitSelectionLimit/);
  assert.match(groupApi, /EVENT_TICKET_SELECTION_LIMIT_EXCEEDED/);
});
