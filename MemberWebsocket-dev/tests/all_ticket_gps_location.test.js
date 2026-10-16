const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('all ticket sources persist reusable GPS redemption rules', () => {
  const migration = read('supabase/migrations/20260929040000_all_ticket_gps_location_rules.sql');
  for (const table of ['fixed_ticket_templates', 'ticket_templates', 'point_tickets']) {
    assert.match(migration, new RegExp('alter table public\\.' + table));
  }
  assert.match(migration, /event_tickets_apply_fixed_location_rule/);
  assert.match(migration, /point_tickets_apply_location_rule/);
  assert.match(migration, /redeem_point_ticket_with_location/);
  assert.match(migration, /redeem_point_tickets_with_location/);
  assert.match(migration, /verify_ticket_redemption_locations/);
});

test('admin editors expose GPS and explicit address search for event and point-ticket templates', () => {
  const html = read('admin/index.html');
  const editor = read('admin/coupon-location-editor.js');
  const app = read('admin/app.js');
  const fixed = read('admin/fixed-ticket-admin.js');

  for (const id of ['eventTicketAddressSearch', 'ticketAddressSearch', 'eventTicketRequiresLocation', 'ticketRequiresLocation', 'eventTicketLocationDraft', 'ticketLocationDraft', 'eventTicketLocationDraftRadius', 'ticketLocationDraftRadius']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(editor, /nominatim\.openstreetmap\.org\/search/);
  assert.match(editor, /relaxedAddressQuery/);
  assert.match(editor, /countrycodes: 'tw'/);
  assert.match(editor, /params\.set\('viewbox'/);
  assert.match(editor, /waitForGeocoderSlot/);
  assert.match(editor, /geocodeCache/);
  assert.match(editor, /sortCandidatesByMapDistance/);
  assert.match(html, /coupon-location-editor\.js\?v=ticket-address-nearest-fallback-20260929-1/);
  assert.match(editor, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(editor, /window\.TicketLocationEditors/);
  assert.match(editor, /window\.L\.circle/);
  assert.match(editor, /setDraft\(event\.latlng\.lat, event\.latlng\.lng/);
  assert.match(editor, /confirmButton\(\)\?\.addEventListener\('click', commitDraft\)/);
  assert.doesNotMatch(editor, /field\('緯度'/);
  assert.doesNotMatch(editor, /field\('經度'/);
  assert.match(app, /redemptionLocations: window\.TicketLocationEditors\.template\.get\(\)/);
  assert.doesNotMatch(app, /checked && els\.eventTicketType\.value === 'coupon'/);
  assert.match(fixed, /redemptionLocations: window\.TicketLocationEditors\?\.event\?\.get\(\)/);
});

test('server-side APIs enforce GPS for point tickets and accept location rules for all event ticket types', () => {
  const api = read('supabase/functions/api/index.ts');
  const pointApi = read('supabase/functions/pointcard-extension-api/index.ts');
  const fixedApi = read('supabase/functions/fixed-ticket-automation/index.ts');
  const pointUi = read('points/pointcard-ticket-overview.js');

  assert.match(api, /normalizeTicketLocations/);
  assert.match(api, /redeem_member_tickets_for_booking_request/);
  assert.match(read('supabase/migrations/20261006023020_booking_ticket_usage_consistency.sql'), /redeem_point_tickets_with_location/);
  assert.doesNotMatch(api, /ticketType !== "coupon"/);
  assert.match(pointApi, /redeem_member_tickets_for_booking_request/);
  assert.match(pointApi, /LOCATION_OUT_OF_RANGE/);
  assert.match(fixedApi, /requires_location: requiresLocation/);
  assert.match(fixedApi, /redemption_locations: redemptionLocations/);
  assert.match(pointUi, /currentRedemptionLocation/);
  assert.match(pointUi, /\.\.\.\(location \? \{ location \} : \{\}\)/);
});
