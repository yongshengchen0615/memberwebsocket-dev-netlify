const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('single and group booking slot APIs suppress active holiday dates before create', () => {
  const sources = [
    read('supabase/functions/booking-api/index.ts'),
    read('supabase/functions/booking-group-api/index.ts'),
    read('supabase/functions/booking-group-slots-api/index.ts'),
  ];
  for (const source of sources) {
    assert.match(source, /calendar_items/);
    assert.match(source, /item_type["',\s]+holiday|eq\("item_type",\s*"holiday"\)/);
    assert.match(source, /status["',\s]+active|eq\("status",\s*"active"\)/);
    assert.match(source, /starts_on/);
    assert.match(source, /ends_on/);
    assert.match(source, /holidayBlocked/);
    assert.match(source, /slots:\s*\[\]/);
  }
});

test('QA booking slot discovery skips holiday dates instead of retrying create on the same rejected slot', () => {
  const source = read('supabase/functions/user-test-api/index.ts');
  assert.match(source, /for \(let offset = startOffset; offset <= lastOffset; offset \+= 1\)/);
  assert.match(source, /const slots = Array\.isArray/);
  assert.match(source, /if \(available\) return \{ date, startTime:/);
  assert.match(source, /QA_NO_BOOKING_SLOT/);
});

test('QA booking write prefers the newest paired E2E service fixture without changing production ordering', () => {
  const source = read('supabase/functions/user-test-api/index.ts');
  assert.match(source, /startsWith\("E2E QA 標準主服務 "\)/);
  assert.match(source, /Date\.parse\(String\(b\?\.createdAt/);
  assert.match(source, /const normal = qaRegular\[0\] \|\| regular\[0\] \|\| null/);
});

test('paired E2E fixture always binds booking settings to the current run primary technician', () => {
  const migration = read('supabase/migrations/20260923061000_fix_paired_e2e_booking_fixture_primary.sql');
  assert.match(migration, /primary_technician_id = v_primary_technician_id/);
  assert.match(migration, /max_party_size = greatest\(max_party_size,2\)/);
  assert.doesNotMatch(migration, /elsif v_existing_primary_technician_id is null/);
  assert.match(migration, /'primaryTechnicianId',[\s\S]*booking_settings where id=1/);
});
