const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('point offer selection prefers a ticket that does not require GPS, even if listed second', async () => {
  const code = stripTypeScriptTypes(read('supabase/functions/_shared/latest-available-offers.ts'));
  const offersModule = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const rewards = [{ id:'reward-1', point_card_id:'card-1',ticket_template_id:'template-1',
    threshold_stamps:5, required_service_ids:[], required_service_match_mode:'any' }];
  const cards = [{ id:'card-1', title:'會員集點卡', status:'active', expiry_mode:'unlimited',
    style_key:'forest', sort_order:1 }];
  const templates = [{ id:'template-1', title:'優惠票券', status:'active' }];
  const restricted = { ticket_id:'PT-LOCATION', reward_id:'reward-1',point_card_id:'card-1',
    ticket_template_id:'template-1',threshold_stamps:5,requires_location:true };
  const unrestricted = { ...restricted, ticket_id:'PT-REGULAR',requires_location:false };
  const available = offersModule.selectLatestPointOffers(
    rewards,cards,templates,[restricted,unrestricted],'2026-10-12'
  );
  assert.equal(available.length,1);
  assert.equal(available[0].ticketId,'PT-REGULAR');
  assert.equal(available[0].requiresLocation,false);
  const onlyRestricted = offersModule.selectLatestPointOffers(
    rewards,cards,templates,[restricted],'2026-10-12'
  );
  assert.equal(onlyRestricted[0].ticketId,'PT-LOCATION');
  assert.equal(onlyRestricted[0].requiresLocation,true);
});

test('the booking catalog allows GPS-only point tickets while snapshot retains location controls', () => {
  const latest = read('supabase/functions/_shared/latest-available-offers.ts');
  const catalog = read('supabase/functions/_shared/booking-benefits.ts');
  const api = read('supabase/functions/booking-receipt-api/index.ts');
  assert.match(latest, /threshold_stamps,requires_location/);
  assert.match(catalog, /const locationRestricted = offer\.requiresLocation === true/);
  assert.match(catalog, /selectable: hasTicket && hasEnoughPoints && !reservedForOtherBooking,/);
  assert.match(catalog, /現場單獨使用需 GPS 定位/);
  assert.doesNotMatch(catalog, /!reservedForOtherBooking && !locationRestricted/);
  assert.match(api, /failure\.includes\("BOOKING_BENEFIT_LOCATION_REQUIRED"\)/);
});

test('database distinguishes GPS restrictions from stale tickets and does not reinstate advance booking', () => {
  const sql = read('supabase/migrations/20261012092000_snapshot_location_restriction_error.sql');
  assert.match(sql, /t\.requires_location into title,cost,card,location_required/);
  assert.match(sql, /e\.requires_location into title,location_required/);
  assert.match(sql, /if not found then raise exception 'BOOKING_BENEFIT_NOT_AVAILABLE'/);
  assert.match(sql, /if coalesce\(location_required,false\) then raise exception 'BOOKING_BENEFIT_LOCATION_REQUIRED'/);
  assert.doesNotMatch(sql, /and not [te]\.requires_location/);
  assert.doesNotMatch(sql, /ticket_booking_required/);
  assert.match(sql, /if p_booking is not null then/);
  assert.match(sql, /revoke all on function public\.validate_snapshot_ticket_selection/);
});
