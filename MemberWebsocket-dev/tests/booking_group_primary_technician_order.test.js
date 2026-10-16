const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('primary technician may be assigned to any booking participant', () => {
  const member = read('booking/group-booking.js');
  assert.match(
    member,
    /state\.participantTechnicians\.filter\(\(id\) => id && id === state\.primaryTechnicianId\)\.length/,
  );
  assert.match(member, /technicianId: state\.participantTechnicians\[0\] \|\| null/);
  assert.match(member, /technicianId: state\.participantTechnicians\[index \+ 1\] \|\| null/);
});

test('group slot APIs do not reserve the primary technician with the legacy whole-booking row', () => {
  const dedicated = read('supabase/functions/booking-group-slots-api/index.ts');
  const compatibility = read('supabase/functions/booking-group-api/index.ts');

  assert.match(
    dedicated,
    /\.in\("technician_id", legacyTechnicianIds\)\s*\.eq\("party_size", 1\)\s*\.in\("status", \["pending", "confirmed"\]\)/,
  );
  assert.match(
    compatibility,
    /\.in\("technician_id",legacyTechnicianIds\)\.eq\("party_size",1\)\.in\("status",\["pending","confirmed"\]\)/,
  );
});

test('database overlap constraint delegates multi-person technician capacity to participant reservations', () => {
  const migration = read('supabase/migrations/20260918161956_fix_group_booking_primary_participant_overlap.sql');

  assert.match(migration, /GROUP_BOOKING_RESERVATION_COVERAGE_INCOMPLETE/);
  assert.match(migration, /booking_participant_reservations/);
  assert.match(migration, /and party_size = 1/);
  assert.match(migration, /exclude using gist/);
});
