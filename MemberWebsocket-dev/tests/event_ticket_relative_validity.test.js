// AC: issued tickets gain a per-member expiry without regressing campaign dates.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const read = (path) => readFileSync(join(__dirname, '..', path), 'utf8');
const migration = read('supabase/migrations/20261124143000_event_ticket_relative_validity.sql');
const api = read('supabase/functions/api/index.ts');
const admin = read('admin/app.js');
const html = read('admin/index.html');
const event = read('event/app.js');
const sharedTicketUi = read('event-ticket-ui.js');

test('AC-001/002: admin has fixed, relative and both modes with server validation', () => {
  for (const mode of ['fixed', 'relative', 'both'])
    assert.match(html, new RegExp('value="' + mode + '"'));
  assert.match(html, /eventTicketValidityDays/);
  assert.match(admin, /validityMode:/);
  assert.match(admin, /validityDays:/);
  assert.match(api, /INVALID_VALIDITY_MODE/);
  assert.match(api, /INVALID_VALIDITY_DAYS/);
});

test('AC-003/009: database snapshots expiry on issuance; legacy tickets stay fixed', () => {
  assert.match(migration, /add column if not exists validity_mode text not null default 'fixed'/i);
  assert.match(migration, /add column if not exists expires_at timestamptz/i);
  assert.match(migration, /make_interval\(days\s*=>\s*v_days\)/i);
  assert.match(migration, /least\(new\.expires_at/i);
  assert.match(migration, /before insert on public\.event_ticket_claims/);
  assert.match(migration, /EVENT_VALIDITY_LOCKED/);
});

test('AC-004/006/007/011: expiry is enforced in PostgreSQL for redemption, booking and gifting', () => {
  assert.match(migration, /EVENT_TICKET_EXPIRED/);
  assert.match(migration, /before update of status on public\.event_ticket_claims/);
  assert.match(migration, /before insert or update on public\.booking_benefit_selections/);
  assert.match(migration, /before update of expires_at,claimed_at,event_ticket_id,member_id on public\.event_ticket_claims/);
  assert.match(migration, /business_\[0-9a-f\]\{32\}/);
  assert.match(migration, /business_templates/);
});

test('AC-005/008/010: API never trusts member expiry fields or allows silent save loss', () => {
  assert.match(api, /validityMode: row\.validity_mode/);
  assert.match(api, /expiresAt: row\.expires_at/);
  assert.match(api, /validity_mode: validityMode/);
  assert.match(admin, /後端未保留活動票券使用期限設定/);
});

test('AC-004: member page displays owned deadline and disables expired use', () => {
  assert.match(api, /claimExpired/);
  assert.match(api, /availability = claimExpired/);
  assert.match(event, /獲得後/);
  assert.match(event, /已到期/);
  assert.match(event, /expiresAt: offer\.claim/);
  assert.match(sharedTicketUi, /票券期限/);
  assert.match(sharedTicketUi, /validityMode/);
});

test('AC-REL-REVIEW-001: shared catalog suppresses expired claims for booking, snapshot and notification consumers', () => {
  const latest = read('supabase/functions/_shared/latest-available-offers.ts');
  assert.match(latest, /claim_id,event_ticket_id,member_id,status,expires_at/);
  assert.match(latest, /memberUnavailableClaims\.add\(eventId\)/);
  assert.match(latest, /expires_at/);
});

test('AC-REL-REVIEW-002: canonical snapshot validator checks claim expiry in all merchants and future schemas', () => {
  assert.match(migration, /validate_snapshot_ticket_selection/);
  assert.match(migration, /c\.expires_at is null or c\.expires_at > clock_timestamp\(\)/);
  assert.match(migration, /business_templates/);
  assert.match(migration, /SNAPSHOT_EXPIRY_GUARD_SHAPE_CHANGED/);
});
