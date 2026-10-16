const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('admin full refresh has one coordinator with a trailing refresh queue', () => {
  const source = read('admin/app.js');
  assert.match(source, /let adminRefreshPromise = null/);
  assert.match(source, /let adminRefreshQueued = false/);
  assert.match(source, /if \(adminRefreshPromise\) return adminRefreshPromise/);
  assert.match(source, /do \{[\s\S]*admin\.bootstrap[\s\S]*\} while \(adminRefreshQueued && state\.idToken\)/);
});

test('booking writes classify uncertain responses and reuse idempotency keys', () => {
  const common = read('booking/common.js');
  const group = read('booking/group-booking.js');
  const app = read('booking/app.js');
  assert.match(common, /const WRITE_ACTIONS = new Set/);
  assert.match(common, /API_RESPONSE_UNCERTAIN/);
  assert.match(group, /API_RESPONSE_UNCERTAIN/);
  assert.match(app, /pendingBookingWrite/);
  assert.match(app, /bookingWriteFingerprint/);
  assert.match(app, /recoverUncertainBookingWrite/);
  assert.match(app, /state\.pendingBookingWrite\.requestId/);
});

test('profile synchronization is event driven and uses one transport owner', () => {
  const system = read('member-system.js');
  const profile = read('member/profile-extension.js');
  const birthday = read('member/profile-birthday-edit.js');
  assert.match(system, /function getSession\(surface\)/);
  assert.match(profile, /member-profile-ready/);
  assert.match(profile, /member-profile-updated/);
  assert.match(birthday, /member-profile-ready/);
  assert.match(birthday, /member-profile-updated/);
  assert.doesNotMatch(profile, /setTimeout|scheduleProfileSync|wait\(350\)/);
  assert.doesNotMatch(profile, /AbortController|fetch\(/);
  assert.doesNotMatch(birthday, /AbortController|fetch\(/);
});

test('backend background work and database batching avoid request-timing guesses', () => {
  const api = read('supabase/functions/api/index.ts');
  const booking = read('supabase/functions/booking-api/index.ts');
  const migration = read('supabase/migrations/20260921061531_batch_issue_eligible_point_tickets.sql');
  assert.match(api, /EdgeRuntime\.waitUntil/);
  assert.match(api, /issue_eligible_point_tickets_for_member/);
  assert.match(booking, /\.in\("id", requested\.map\(\(item\) => item\.serviceId\)\)/);
  assert.doesNotMatch(booking.slice(booking.indexOf('async function normalizeRequestedItems'), booking.indexOf('function totalDuration')), /\.eq\("id", serviceId\)\.maybeSingle\(\)/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /revoke execute[\s\S]*from anon, authenticated/);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
});
