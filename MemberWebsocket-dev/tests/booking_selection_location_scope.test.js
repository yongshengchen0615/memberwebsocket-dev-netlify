const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('supabase/migrations/20261012133000_booking_selection_without_gps.sql');
const selection = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.replace_booking_benefit_selections_request'),
  migration.indexOf('CREATE OR REPLACE FUNCTION public.complete_booking_with_benefits_request'),
);
const completion = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.complete_booking_with_benefits_request'));
const privileged = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.redeem_event_tickets_for_booking_request'),
  migration.indexOf('revoke all on function public.redeem_event_tickets_for_booking_request'),
);

test('ordinary booking accepts GPS-restricted point and event selections without GPS', () => {
  assert.match(selection, /v_kind='points'/);
  assert.match(selection, /v_kind='event'/);
  assert.doesNotMatch(selection, /BOOKING_BENEFIT_LOCATION_REQUIRED/);
  assert.match(selection, /BOOKING_BENEFIT_NOT_AVAILABLE/);
  assert.match(selection, /booking_ticket_matches_services|reconcile_booking_ticket_services/);
  assert.match(selection, /v_point.ticket_status <> 'available'/);
  assert.match(selection, /v_event.claim_status <> 'claimed'/);
});

test('admin completion preserves point balance and event limits without requiring GPS', () => {
  assert.doesNotMatch(completion, /BOOKING_BENEFIT_LOCATION_REQUIRED/);
  assert.match(completion, /public\.redeem_point_tickets\(/);
  assert.match(completion, /public\.redeem_event_tickets_for_booking_request\(/);
  assert.match(completion, /public\.complete_booking_with_rewards_request\(/);
});

test('event settlement GPS bypass is server-only, booking-owned, confirmed and reserved', () => {
  assert.match(privileged, /p_booking_id uuid\)/);
  assert.match(privileged, /v_booking.status<>'confirmed'/);
  assert.match(privileged, /v_booking.completed_at is not null/);
  assert.match(privileged, /v_booking.cancellation_requested_at is not null/);
  assert.match(privileged, /s.booking_id=p_booking_id and s.member_id=v_member.id/);
  assert.match(privileged, /s.status='pending' and s.benefit_kind='event'/);
  assert.match(privileged, /s.benefit_ref=any\(p_claim_ids\)/);
  assert.match(migration, /revoke all on function public\.redeem_event_tickets_for_booking_request\(text,text\[\],text,jsonb,uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.redeem_event_tickets_for_booking_request\(text,text\[\],text,jsonb,uuid\) to service_role/);
});

test('customer-facing event and point ticket redemptions retain server-side GPS rules', () => {
  assert.match(read('supabase/migrations/20260929040000_all_ticket_gps_location_rules.sql'), /verify_ticket_redemption_locations/);
  assert.match(read('supabase/migrations/20261006023020_booking_ticket_usage_consistency.sql'), /redeem_point_tickets_with_location/);
  assert.match(read('supabase/migrations/20261006023020_booking_ticket_usage_consistency.sql'), /redeem_event_tickets_with_location/);
  assert.match(privileged, /verify_ticket_redemption_locations/);
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION public\.redeem_event_tickets_with_location\(/);
  assert.match(read('supabase/functions/api/index.ts'), /redeem_member_tickets_for_booking_request/);
});

test('snapshot GPS requirements remain independent of normal booking selection', () => {
  assert.match(read('supabase/migrations/20261012092000_snapshot_location_restriction_error.sql'), /BOOKING_BENEFIT_LOCATION_REQUIRED/);
  assert.match(read('supabase/migrations/20261010021829_snapshot_location_policy.sql'), /SNAPSHOT_LOCATION_REQUIRED/);
});
