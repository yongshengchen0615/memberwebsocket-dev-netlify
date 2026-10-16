const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const offers = import(pathToFileURL(path.join(root, 'supabase/functions/_shared/latest-available-offers.ts')));
const benefits = import(pathToFileURL(path.join(root, 'supabase/functions/booking-line-notifications/benefits.ts')));

function fixture(overrides = {}, fail = '') {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const tables = {
    bookings: [{ id: 'booking-1', member_id: 'member-1' }],
    members: [{ id: 'member-1', line_user_id: 'LINE-1', status: 'active', membership_status: 'active', birthday: '1990-01-01' }],
    membership_tier_settings: [{ tier_key: 'silver', tier_label: '銀級會員' }],
    point_cards: [{ id: 'card-1', title: '集點卡', status: 'active', expiry_mode: 'unlimited' }],
    point_tickets: [{ member_id: 'member-1', status: 'available', point_card_id: 'card-1', ticket_title: '集點券' }],
    point_card_rewards: [], ticket_templates: [],
    event_tickets: [{ id: 'event-1', title: '活動券', status: 'active', allowed_tier_keys: ['silver'], quota: 1 }],
    event_ticket_claims: [{ member_id: 'member-1', event_ticket_id: 'event-1', ticket_title: '活動券', status: 'claimed', event_tickets: { status: 'active', allowed_tier_keys: ['silver'] } }],
    calendar_items: [{ id: 'calendar-1', title: '銀級活動', item_type: 'event', status: 'active', starts_on: today, allowed_tier_keys: ['silver'] }],
    ...overrides,
  };
  const calls = [];
  const db = {
    from(table) {
      let rows = tables[table] || [];
      let single = false;
      const query = {
        select() { return query; },
        eq(key, value) { calls.push({ table, key, value }); rows = rows.filter((row) => row[key] === value); return query; },
        is(key, value) { rows = rows.filter((row) => (row[key] ?? null) === value); return query; },
        in(key, values) { rows = rows.filter((row) => values.includes(row[key])); return query; },
        order() { return query; }, limit(value) { rows = rows.slice(0, value); return query; },
        maybeSingle() { single = true; return query; },
        then(resolve, reject) { return Promise.resolve({ data: single ? rows[0] || null : rows, error: fail === table ? new Error('fixture') : null }).then(resolve, reject); },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      if (name === 'current_tier_key') return { data: 'silver', error: null };
      if (name === 'event_ticket_claim_counts') return { data: [{ event_ticket_id: 'event-1', claimed_count: 1 }], error: fail === name ? new Error('fixture') : null };
      return { data: null, error: null };
    },
  };
  return { db, calls };
}

test('database claimed tickets stay usable even after inventory sells out', async () => {
  const { selectLatestEventOffers } = await offers;
  assert.deepEqual(selectLatestEventOffers([{ id: 'event', title: '已領券', quota: 1 }], [
    { event_ticket_id: 'event', member_id: 'member', status: 'claimed' },
  ], 'member'), [{
    eventId: 'event',
    title: '已領券',
    claimed: true,
    requiredServiceIds: [],
    requiredServiceMatchMode: 'any',
  }]);
});

test('used and cancelled claims cannot be advertised as claimable again', async () => {
  const { selectLatestEventOffers } = await offers;
  for (const status of ['used', 'cancelled']) {
    assert.deepEqual(selectLatestEventOffers([{ id: 'event', quota: 0 }], [
      { event_ticket_id: 'event', member_id: 'member', status },
    ], 'member'), []);
  }
});

test('cancelled claims still consume inventory consistently with the canonical SQL count', async () => {
  const { selectLatestEventOffers } = await offers;
  assert.deepEqual(selectLatestEventOffers([{ id: 'event', quota: 1 }], [
    { event_ticket_id: 'event', member_id: 'other', status: 'cancelled' },
  ], 'member'), []);
});

test('server-issued fixed tickets are only shown to their owner', async () => {
  const { selectLatestEventOffers } = await offers;
  const events = [{ id: 'event', title: '固定票券', quota: 0, fixed_ticket_template_id: 'fixed' }];
  const claims = [{ event_ticket_id: 'event', member_id: 'owner', status: 'claimed' }];
  assert.equal(selectLatestEventOffers(events, claims, 'owner').length, 1);
  assert.deepEqual(selectLatestEventOffers(events, claims, 'other'), []);
});

test('aggregate inventory counts prevent overselling without downloading other members claims', async () => {
  const { selectLatestEventOffers, buildLatestAvailableOffersSection } = await offers;
  assert.deepEqual(selectLatestEventOffers([{ id: 'event', quota: 1 }], [], 'member', [
    { event_ticket_id: 'event', claimed_count: 1 },
  ]), []);
  const { db, calls } = fixture();
  const section = await buildLatestAvailableOffersSection(db, 'member-1', 'silver', { strict: true });
  assert.match(section, /（已領取）/);
  assert.ok(calls.some((call) => call.table === 'event_ticket_claims' && call.key === 'member_id' && call.value === 'member-1'));
  assert.ok(calls.some((call) => call.rpc === 'event_ticket_claim_counts'));
});

test('deleted, ineligible, future and expired event offers are excluded', async () => {
  const { buildLatestAvailableOffersSection } = await offers;
  for (const patch of [{ deleted_at: '2026-01-01' }, { allowed_tier_keys: [] }, { allowed_tier_keys: ['gold'] }, { starts_on: '9999-01-01' }, { ends_on: '2000-01-01' }]) {
    const { db } = fixture({ event_tickets: [{ id: 'event-1', title: '不可用', status: 'active', quota: 0, allowed_tier_keys: ['silver'], ...patch }] });
    assert.equal(await buildLatestAvailableOffersSection(db, 'member-1', 'silver', { strict: true }), '');
  }
});

test('strict scheduled messages fail instead of announcing stale inventory after a count error', async () => {
  const { buildLatestAvailableOffersSection } = await offers;
  const { db } = fixture({}, 'event_ticket_claim_counts');
  await assert.rejects(buildLatestAvailableOffersSection(db, 'member-1', 'silver', { strict: true }));
});

test('booking benefits include all three current entitlement categories', async () => {
  const { loadBookingConfirmationBenefits } = await benefits;
  const { db } = fixture();
  const result = await loadBookingConfirmationBenefits(db, { booking_id: 'booking-1', recipient: 'LINE-1' });
  assert.equal(result.pointTickets.length, 1);
  assert.equal(result.eventTickets.length, 1);
  assert.equal(result.tierActivities.length, 1);
  assert.equal(result.tierLabel, '銀級會員');
});

test('disabled accounts and unjoined memberships receive no usable benefits or ticket issuance', async () => {
  const { loadBookingConfirmationBenefits } = await benefits;
  for (const patch of [{ status: 'disabled' }, { membership_status: 'pending' }]) {
    const { db, calls } = fixture({ members: [{ id: 'member-1', line_user_id: 'LINE-1', status: 'active', membership_status: 'active', ...patch }] });
    const result = await loadBookingConfirmationBenefits(db, { booking_id: 'booking-1', recipient: 'LINE-1' });
    assert.deepEqual([result.pointTickets, result.eventTickets, result.tierActivities], [[], [], []]);
    assert.equal(calls.some((call) => call.rpc === 'issue_eligible_point_tickets_for_member'), false);
  }
});

test('recipient mismatch and missing booking fail before reading entitlements', async () => {
  const { loadBookingConfirmationBenefits } = await benefits;
  const { db, calls } = fixture();
  await assert.rejects(loadBookingConfirmationBenefits(db, { booking_id: 'booking-1', recipient: 'OTHER' }), /RECIPIENT_MISMATCH/);
  await assert.rejects(loadBookingConfirmationBenefits(db, { booking_id: 'missing', recipient: 'LINE-1' }), /MEMBER_NOT_FOUND/);
  assert.equal(calls.some((call) => call.table === 'point_cards'), false);
});

test('booking notifications exclude expired cards, used claims and full linked activities', async () => {
  const { loadBookingConfirmationBenefits } = await benefits;
  const { db } = fixture({
    point_cards: [{ id: 'card-1', status: 'active', expiry_mode: 'date', expires_on: '2000-01-01' }],
    event_ticket_claims: [{ member_id: 'member-1', event_ticket_id: 'event-1', status: 'used' }],
    calendar_items: [{ id: 'calendar-1', title: '額滿活動', item_type: 'event', status: 'active', allowed_tier_keys: ['silver'], source_event_ticket_id: 'event-1' }],
  });
  const result = await loadBookingConfirmationBenefits(db, { booking_id: 'booking-1', recipient: 'LINE-1' });
  assert.deepEqual([result.pointTickets, result.eventTickets, result.tierActivities], [[], [], []]);
});

test('booking enrichment query failure stays observable for notification retry', async () => {
  const { loadBookingConfirmationBenefits } = await benefits;
  const { db } = fixture({}, 'calendar_items');
  await assert.rejects(loadBookingConfirmationBenefits(db, { booking_id: 'booking-1', recipient: 'LINE-1' }), /BENEFIT_QUERY_FAILED/);
});
