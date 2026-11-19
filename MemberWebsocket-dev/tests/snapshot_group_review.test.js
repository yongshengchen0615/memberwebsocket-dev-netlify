const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('snapshot review removes existing booking linking and uses per-person editors', () => {
  const ui = read('admin/booking-accessible-admin.js');
  assert.doesNotMatch(ui, /accessibleAdminExisting/);
  assert.match(ui, /accessibleAdminPartySize/);
  assert.match(ui, /accessibleAdminParticipants/);
  assert.match(ui, /data-technician-select/);
  assert.match(ui, /data-snapshot-service/);
  assert.match(ui, /function collectSnapshotParticipants\(/);
  assert.match(ui, /bookingDate:[^\n]+startTime:[^\n]+participants,benefits/);
});

test('snapshot review obtains active technician catalog and preserves primary requirement', () => {
  const api = read('supabase/functions/booking-receipt-api/index.ts');
  assert.match(api, /from\("booking_technicians"\)/);
  assert.match(api, /primaryTechnicianId:/);
  assert.match(api, /maxPartySize:/);
  assert.match(api, /technicians:/);
  assert.doesNotMatch(api, /admin\.booking\.receipt\.options',[^{]*\{receiptId:state\.selected\.receiptId,bookingId\}/);
});

test('snapshot review sends participant services to canonical benefit eligibility', () => {
  const ui = read('admin/booking-accessible-admin.js');
  const api = read('supabase/functions/booking-receipt-api/index.ts');
  assert.match(ui, /function selectedServiceIds\(/);
  assert.match(api, /rawItems.*(?:flatMap|participants|items)/s);
  assert.match(api, /p_items:.*participants/);
});

test('snapshot registration blocks link-to-existing and creates participant-owned rows atomically', () => {
  const migration = read('supabase/migrations/20261119114000_snapshot_group_review_no_existing_link.sql');
  assert.match(migration, /SNAPSHOT_EXISTING_BOOKING_LINK_DISABLED/);
  assert.match(migration, /INVALID_BOOKING_PARTICIPANTS/);
  assert.match(migration, /booking_participants/);
  assert.match(migration, /booking_participant_items/);
  assert.match(migration, /booking_items/);
  assert.match(migration, /party_size/);
  assert.match(migration, /booking_completion_settlements|register_accessible_receipt_with_benefits_request/);
  assert.match(migration, /platform_private\.business_templates/);
  assert.match(migration, /quote_ident\(/);
});
