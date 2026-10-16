const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('booking API exposes server time for client clock synchronization', () => {
  const source = read('supabase/functions/booking-api/index.ts');
  assert.ok((source.match(/serverNow: new Date\(\)\.toISOString\(\)/g) || []).length >= 3);
  assert.match(source, /async function userBootstrap/);
  assert.match(source, /async function generateSlots/);
});

test('member booking edit and cancel decisions use the server-synchronized monotonic clock', () => {
  const source = read('booking/app.js');
  assert.match(source, /function syncServerClock\(/);
  assert.match(source, /function currentServerTimeMs\(/);
  assert.match(source, /performance\.now\(\)/);
  assert.match(source, /const cancellationPending = Boolean\(booking\?\.cancellationRequestedAt && !booking\?\.cancellationReviewedAt\)/);
  assert.match(source, /startsAt > currentServerTimeMs\(\)/);
  assert.doesNotMatch(source, /startsAt > Date\.now\(\)/);
});

test('admin booking-service update closes the read-then-write race', () => {
  const source = read('supabase/functions/booking-admin-api/index.ts');
  assert.match(source, /\.eq\("updated_at", current\.data\.updated_at\)/);
  assert.match(source, /if \(!updated\.data\) throw new ApiError\(409, "BOOKING_SERVICE_CONFLICT"/);
});

test('database booking guards evaluate business time at row-mutation wall clock', () => {
  const source = read('supabase/migrations/20260919074104_harden_booking_live_clock.sql');
  assert.match(source, /clock_timestamp\(\) at time zone 'Asia\/Taipei'/);
  assert.match(source, /create trigger bookings_enforce_live_clock/);
  assert.match(source, /before insert or update of booking_date, start_time, status/);
  assert.match(source, /raise exception 'BOOKING_TIME_PASSED'/);
  assert.doesNotMatch(source, /v_today date := \(now\(\) at time zone 'Asia\/Taipei'\)/);
});

test('ticket and benefit validity checks use live business time after lock waits', () => {
  const source = read('supabase/migrations/20260919074433_harden_live_business_clock.sql');
  assert.match(source, /claim_event_ticket/);
  assert.match(source, /redeem_event_ticket/);
  assert.match(source, /redeem_point_tickets/);
  assert.match(source, /grant_member_benefits_with_event_bonus/);
  assert.match(source, /clock_timestamp\(\) at time zone ''Asia\/Taipei''/);
});

test('realtime invalidation events have bounded retention', () => {
  const source = read('supabase/migrations/20260919074608_bound_realtime_event_retention.sql');
  assert.match(source, /create trigger realtime_events_prune_after_insert/);
  assert.match(source, /created_at < clock_timestamp\(\) - interval '7 days'/);
  assert.match(source, /for each statement/);
});
