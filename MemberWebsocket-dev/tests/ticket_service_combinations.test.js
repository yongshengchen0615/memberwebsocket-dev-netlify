const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const booking = read('booking/booking-benefits.js');
const migration = read('supabase/migrations/20261030050000_ticket_booking_service_groups.sql');
const admin = read('admin/app.js');
const api = read('supabase/functions/api/index.ts');
const latest = read('supabase/functions/_shared/latest-available-offers.ts');
const benefits = read('supabase/functions/_shared/booking-benefits.ts');

const serviceRequirementSource = booking.split('  function serviceRequirementMet(item) {')[1]?.split('  function serviceRequirementMessage(item) {')[0];
assert.ok(serviceRequirementSource, 'booking client service eligibility predicate must exist');
function matches(item, selected) {
  const factory = new Function('currentServiceIds', 'requiredServiceIds', 'serviceIdKey',
    'function serviceRequirementMet(item) {' + serviceRequirementSource + '\nreturn serviceRequirementMet;');
  const fn = factory(new Set(selected), entry => entry.requiredServiceIds || [], value => String(value));
  return fn(item);
}

test('AC-001: A+B OR A+C accepts either complete group and additional booked services', () => {
  const ticket = { requiredServiceIds: [], requiredServiceGroups: [['A','B'],['A','C']] };
  for (const selected of [['A','B'],['A','C'],['A','B','C'],['A','B','D']])
    assert.equal(matches(ticket, selected), true, selected.join('+'));
});

test('AC-002: groups must be satisfied entirely; empty group cannot unlock ticket', () => {
  const ticket = { requiredServiceIds: [], requiredServiceGroups: [['A','B'],['A','C']] };
  for (const selected of [[],['A'],['B'],['C'],['B','C'],['A','D']])
    assert.equal(matches(ticket, selected), false, selected.join('+'));
  assert.equal(matches({requiredServiceGroups:[[]]}, []), false);
});

test('AC-003: existing any/all mode and unrestricted tickets preserve their behavior', () => {
  assert.equal(matches({ requiredServiceIds:['A','B'], requiredServiceMatchMode:'any' },['B']),true);
  assert.equal(matches({ requiredServiceIds:['A','B'], requiredServiceMatchMode:'all' },['B']),false);
  assert.equal(matches({ requiredServiceIds:['A','B'], requiredServiceMatchMode:'all' },['A','B']),true);
  assert.equal(matches({ requiredServiceIds:[] },[]),true);
});

test('AC-004: admin editors serialize groups for point card reward and event ticket', () => {
  assert.match(admin, /function renderRequiredServiceGroups\(/);
  assert.match(admin, /function collectRequiredServiceGroups\(/);
  assert.match(admin, /requiredServiceGroups: collectRequiredServiceGroups\(row\.querySelector/);
  assert.match(admin, /requiredServiceGroups: collectRequiredServiceGroups\(document\.getElementById/);
  assert.match(read('admin/index.html'), /id="eventTicketRequiredServiceGroups"/);
  assert.match(read('admin/index.html'), /value="groups"/);
});

test('AC-005: backend validates group length, duplicate items and deleted service ids', () => {
  assert.match(api, /normalizeRequiredServiceGroups/);
  assert.match(api, /value\.length > 10/);
  assert.match(api, /count > 40/);
  assert.match(api, /new Set\(ids\)\.size !== ids\.length/);
  assert.match(api, /!allowed\.has\(id\)/);
  assert.match(api, /required_service_groups: requiredServiceGroups/);
  assert.match(api, /requiredServiceGroups \}/);
});

test('AC-006: database checks service groups throughout all booking redemption entrypoints', () => {
  assert.match(migration, /nspname='public' or nspname ~ '\^business_/);
  assert.match(migration, /booking_meets_required_service_groups/);
  assert.match(migration, /where bi\.booking_id=p_booking_id/);
  assert.match(migration, /where bp\.booking_id=p_booking_id/);
  assert.match(migration, /not exists \(\s*select 1 from jsonb_array_elements_text\(grp\.items\)/);
  assert.match(migration, /ticket_has_service_requirement/);
  assert.match(migration, /booking_ticket_matches_services/);
  assert.match(migration, /validate_booking_benefit_service_requirement_row/);
  assert.match(migration, /validate_booking_service_requirements_on_completion/);
  assert.match(migration, /prevent_delete_ticket_required_service_item/);
  assert.match(migration, /validate_ticket_required_service_ids/);
  assert.match(migration, /revoke all on function/);
  assert.match(migration, /INVALID_REQUIRED_SERVICE_GROUPS/);
});

test('AC-007: availability and booking benefit metadata retain group membership', () => {
  assert.match(latest, /requiredServiceGroups\?: string\[\]\[\]/);
  assert.match(latest, /required_service_groups/);
  assert.match(benefits, /groupRequirementLabelFor/);
  assert.match(benefits, /requiredServiceGroups, requiredServiceTitles/);
});
