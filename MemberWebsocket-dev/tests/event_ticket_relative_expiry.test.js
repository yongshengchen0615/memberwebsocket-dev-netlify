'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20261124140000_event_ticket_claim_relative_expiry.sql');
const api = read('supabase/functions/api/index.ts');
const batchApi = read('supabase/functions/event-ticket-extension-api/index.ts');
const admin = read('admin/app.js');
const adminHtml = read('admin/index.html');
const event = read('event/app.js');
const eventUi = read('event-ticket-ui.js');
const bookingOffers = read('supabase/functions/_shared/latest-available-offers.ts');
const bookingBenefits = read('supabase/functions/_shared/booking-benefits.ts');
const bookingUi = read('booking/booking-benefits.js');

test('AC-001: admin edits nullable 1..3650-day duration with server-side validation', () => {
  assert.match(adminHtml, /id="eventTicketValidityDaysAfterClaim"[^>]+min="1"[^>]+max="3650"/);
  assert.match(admin, /validityDaysAfterClaim: els\.eventTicketValidityDaysAfterClaim\.value/);
  assert.match(admin, /ticket\.validityDaysAfterClaim !== null && \(!Number\.isInteger/);
  assert.match(api, /validityDaysAfterClaim < 1 \|\| validityDaysAfterClaim > 3650/);
  assert.match(api, /validity_days_after_claim: validityDaysAfterClaim/);
  assert.match(migration, /validity_days_after_claim between 1 and 3650/);
});

test('AC-002: old clients and existing tickets keep their fixed-date behavior', () => {
  assert.match(api, /Object\.prototype\.hasOwnProperty\.call\(input,"validityDaysAfterClaim"\)/);
  assert.match(api, /starts_on: startsOn \|\| null/);
  assert.match(api, /ends_on: endsOn \|\| null/);
  assert.match(migration, /add column if not exists validity_days_after_claim integer/);
  assert.match(migration, /add column if not exists expires_at timestamptz/);
  assert.match(migration, /new\.expires_at := case when v_days is null then null/);
});

test('AC-003: deadline snapshots are calculated from each issued claim and immutable', () => {
  assert.match(migration, /before insert on %I\.event_ticket_claims/);
  assert.match(migration, /new\.claimed_at \+ make_interval\(days => v_days\)/);
  assert.match(migration, /new\.expires_at is distinct from old\.expires_at/);
  assert.match(migration, /EVENT_TICKET_EXPIRY_IMMUTABLE/);
});

test('AC-004: expired claims cannot be used or reserved for booking', () => {
  assert.match(migration, /new\.status = 'used'/);
  assert.match(migration, /clock_timestamp\(\) >= old\.expires_at/);
  assert.match(migration, /guard_booking_event_ticket_expiry/);
  assert.match(migration, /new\.benefit_kind = 'event' and new\.status = 'pending'/);
  assert.match(migration, /EVENT_TICKET_CLAIM_EXPIRED/);
  assert.match(batchApi, /EVENT_TICKET_CLAIM_EXPIRED/);
  assert.match(api, /EVENT_TICKET_CLAIM_EXPIRED/);
});

test('AC-005: each member sees actual acquired deadline, with expired status and no use action', () => {
  assert.match(api, /expiresAt: row\.expires_at \|\| ""/);
  assert.match(api, /claimRow\?\.expires_at && Date\.parse/);
  assert.match(api, /expired \? "expired"/);
  assert.match(api, /canUse: Boolean\(claim && claim\.status === "available" && tierEligible && availability === "active"/);
  assert.match(eventUi, /row\('到期時間', String\(options\.expiresAt\)\)/);
  assert.match(event, /offer\.availability === 'expired'/);
  assert.match(event, /這張票券已過期/);
});

test('AC-006: migration installs existing public/tenant schemas and future merchant provisioning', () => {
  assert.match(migration, /install_event_ticket_relative_expiry\('public'\)/);
  assert.match(migration, /from platform_private\.tenants where runtime_schema is not null/);
  assert.match(migration, /platform_provision_business_before_event_ticket_relative_expiry/);
  assert.match(migration, /install_event_ticket_relative_expiry\(v_schema\)/);
  assert.match(migration, /INVALID_BUSINESS_SCHEMA/);
});

test('AC-007: frontend uses fixed-window plus claim-relative validity without changing redeemed history', () => {
  assert.match(eventUi, /row\(options\.history \? '使用時間' : '活動期間'/);
  assert.match(eventUi, /relativeDays/);
  assert.match(api, /const ended = Boolean\(row\.ends_on && today > row\.ends_on\)/);
  assert.match(api, /const availability = expired \? "expired" : scheduled \? "scheduled" : ended \? "ended" : "active"/);
  assert.match(event, /if \(offer\.history\) return/);
});

test('AC-008: booking read model includes expiry and does not allow expired claims to be selected', () => {
  assert.match(bookingOffers, /claim_id,event_ticket_id,member_id,status,expires_at/);
  assert.match(bookingOffers, /offer\.expired = Date\.parse\(expiresAt\) <= Date\.now\(\)/);
  assert.match(bookingBenefits, /const expired=offer\.expired===true/);
  assert.match(bookingBenefits, /selectable: Boolean\(offer\.claimId\) && tierEligible && !expired/);
  assert.match(bookingBenefits, /claimRequired: false/);
  assert.match(bookingBenefits, /statusLabel: locked \? '需升級' : expired \? '已過期'/);
  assert.match(bookingUi, /expiresAt: item\.expiresAt/);
});
