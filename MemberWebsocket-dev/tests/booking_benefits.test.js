const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const modulePromise = import(pathToFileURL(path.join(root, 'supabase/functions/_shared/booking-benefits.ts')));
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
const member = { id: 'member-1', line_user_id: 'line-1', display_name: '會員', status: 'active', membership_status: 'active', birthday: '1990-01-01' };

function database(overrides = {}, fail = '') {
  const data = {
    members: [member], membership_tier_settings: [{ tier_key: 'silver', tier_label: '銀級會員', required_service_minutes: 0 }], service_time_entries: [],
    point_cards: [{ id: 'card', card_id: 'CARD', title: '集點卡', status: 'active', expiry_mode: 'unlimited' }],
    point_card_rewards: [{ id: 'reward', point_card_id: 'card', ticket_template_id: 'template', threshold_stamps: 5 }],
    ticket_templates: [{ id: 'template', title: '最新優惠', status: 'active' }],
    point_tickets: [{ ticket_id: 'PT-001', member_id: member.id, status: 'available', reward_id: 'reward', point_card_id: 'card', ticket_template_id: 'template', threshold_stamps: 5 }],
    point_balances: [{ member_id: member.id, point_card_id: 'card', stamps: 10 }],
    event_tickets: [{ id: 'event', event_ticket_id: 'EVENT', title: '活動票券', status: 'active', allowed_tier_keys: ['silver'], quota: 2, requires_location: false }],
    event_ticket_claims: [],
    event_ticket_settings: [{ id: 1, max_tickets_per_day: 2, max_tickets_per_redemption: 2 }],
    point_card_settings: [{ id: 1, max_tickets_per_redemption: 2 }],
    booking_services: [],
    calendar_items: [{ calendar_item_id: 'CAL', title: '會員活動', item_type: 'event', status: 'active', starts_on: today, ends_on: today, allowed_tier_keys: ['silver'] }],
    ...overrides,
  };
  const calls = [];
  return { calls, from(table) {
    let rows = data[table] || [], single = false;
    const q = {
      select() { return q; }, order() { return q; }, update() { return q; }, single() { single = true; return q; },
      eq(key, value) { calls.push({ table, key, value }); rows = rows.filter(row => row[key] === value); return q; },
      is(key, value) { rows = rows.filter(row => (row[key] ?? null) === value); return q; },
      in(key, values) { rows = rows.filter(row => values.includes(row[key])); return q; },
      lte(key, value) { rows = rows.filter(row => row[key] <= value); return q; },
      limit(value) { rows = rows.slice(0, value); return q; },
      maybeSingle() { single = true; return q; },
      then(resolve, reject) {
        calls.push({ table, read: true });
        return Promise.resolve({ data: single ? rows[0] || null : rows, error: fail === table ? new Error('fixture failure') : null }).then(resolve, reject);
      },
    };
    return q;
  }, async rpc(name, args) {
    if (name === 'member_service_minute_totals') return { data: args.p_member_ids.map(member_id => ({ member_id, total_minutes: 0 })), error: null };
    calls.push({ rpc: name, args });
    assert.equal(name, 'event_ticket_claim_counts', 'recommendation must never issue, claim or consume tickets');
    return { error: fail === name ? new Error('fixture failure') : null, data: args.p_event_ids.map(id => ({ event_ticket_id: id, claimed_count: data.event_ticket_claims.filter(row => row.event_ticket_id === id).length })) };
  } };
}

test('booking recommendations cover 0/1/N and return only display fields', async () => {
  const { loadBookingBenefits } = await modulePromise;
  for (const [overrides, count] of [[{}, 3], [{ point_tickets: [], calendar_items: [] }, 1], [{ point_tickets: [], calendar_items: [], event_tickets: [] }, 0]]) {
    const result = await loadBookingBenefits(database(overrides), member, 'silver', today);
    assert.equal(result.items.length, count);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /member_id|line_user_id|allowed_tier|birthday|fixed_ticket_template|claim_id/);
    assert.ok(result.items.every(item => typeof item.conditionLabel === 'string' && item.conditionLabel.length > 0));
    assert.equal(result.eventTicketMaxPerDay, 2);
    assert.equal(result.pointTicketMaxPerRedemption, 2);
  }
});

test('expired/inactive/used/ineligible/future/full benefits are excluded', async () => {
  const { loadBookingBenefits } = await modulePromise;
  const patches = [
    { point_cards: [{ id: 'card', status: 'active', expiry_mode: 'date', expires_on: '2000-01-01' }], event_tickets: [], calendar_items: [] },
    { ticket_templates: [{ id: 'template', status: 'inactive' }], event_tickets: [], calendar_items: [] },
    { point_tickets: [{ member_id: member.id, status: 'used' }], event_tickets: [], calendar_items: [] },
    { point_tickets: [], event_tickets: [{ id: 'event', status: 'active', allowed_tier_keys: ['gold'] }], calendar_items: [] },
    { point_tickets: [], event_tickets: [{ id: 'event', status: 'active', allowed_tier_keys: ['silver'], starts_on: '9999-01-01' }], calendar_items: [] },
    { point_tickets: [], event_tickets: [{ id: 'event', status: 'active', allowed_tier_keys: ['silver'], ends_on: '2000-01-01' }], calendar_items: [] },
    { point_tickets: [], event_tickets: [{ id: 'event', status: 'active', allowed_tier_keys: ['silver'], quota: 1 }], event_ticket_claims: [{ member_id: 'other', event_ticket_id: 'event', status: 'claimed' }], calendar_items: [] },
    { point_tickets: [], event_ticket_claims: [{ member_id: member.id, event_ticket_id: 'event', status: 'used' }], calendar_items: [] },
    { point_tickets: [], event_tickets: [{ id: 'event', status: 'active', allowed_tier_keys: ['silver'], fixed_ticket_template_id: 'fixed' }], event_ticket_claims: [{ member_id: 'other', event_ticket_id: 'event', status: 'claimed' }], calendar_items: [] },
    { point_tickets: [], event_tickets: [], calendar_items: [{ calendar_item_id: 'CAL', item_type: 'event', status: 'active', starts_on: today, ends_on: today, allowed_tier_keys: ['gold'] }] },
  ];
  for (const patch of patches) assert.deepEqual((await loadBookingBenefits(database(patch), member, 'silver', today)).items, []);
});

test('point tickets expose current balance and disable unaffordable tickets', async () => {
  const { loadBookingBenefits } = await modulePromise;
  const affordable = await loadBookingBenefits(database(), member, 'silver', today);
  const point = affordable.items.find(item => item.kind === 'points');
  assert.ok(point);
  assert.equal(point.pointBalance, 10);
  assert.equal(point.pointCost, 5);
  assert.equal(point.selectable, true);
  assert.match(point.conditionLabel, /本卡可用 10 點/);

  const insufficient = await loadBookingBenefits(database({
    point_balances: [{ member_id: member.id, point_card_id: 'card', stamps: 4 }],
  }), member, 'silver', today);
  const blocked = insufficient.items.find(item => item.kind === 'points');
  assert.ok(blocked);
  assert.equal(blocked.selectable, false);
  assert.equal(blocked.statusLabel, '點數不足');
  assert.match(blocked.disabledReason, /目前可用 4 點/);
  assert.match(blocked.disabledReason, /需要 5 點/);
});

test('partial booking service selection keeps the concrete item label', async () => {
  const { loadBookingBenefits } = await modulePromise;
  const result = await loadBookingBenefits(database({
    point_card_rewards: [{
      id: 'reward',
      point_card_id: 'card',
      ticket_template_id: 'template',
      threshold_stamps: 5,
      required_service_ids: ['service-body-60'],
    }],
    booking_services: [
      { id: 'service-body-60', title: '身體60', service_type: '身體' },
      { id: 'service-body-120', title: '身體120', service_type: '身體' },
    ],
  }), member, 'silver', today);
  const point = result.items.find(item => item.kind === 'points');
  assert.ok(point);
  assert.deepEqual(point.requiredServiceIds, ['service-body-60']);
  assert.deepEqual(point.requiredServiceTitles, ['身體60']);
  assert.equal(point.requiredServiceRequirementLabel, '需預約「身體60」項目');
  assert.match(point.conditionLabel, /預約項目限制：需預約「身體60」項目/);
});

test('selecting every item in a service type displays the service type label', async () => {
  const { loadBookingBenefits } = await modulePromise;
  const result = await loadBookingBenefits(database({
    point_card_rewards: [{
      id: 'reward',
      point_card_id: 'card',
      ticket_template_id: 'template',
      threshold_stamps: 5,
      required_service_ids: ['service-body-60', 'service-body-120'],
    }],
    booking_services: [
      { id: 'service-body-60', title: '身體60', service_type: '身體' },
      { id: 'service-body-120', title: '身體120', service_type: '身體' },
      { id: 'service-foot-60', title: '腳底60', service_type: '腳底' },
      { id: 'service-foot-120', title: '腳底120', service_type: '腳底' },
    ],
  }), member, 'silver', today);
  const point = result.items.find(item => item.kind === 'points');
  assert.ok(point);
  assert.deepEqual(point.requiredServiceIds, ['service-body-60', 'service-body-120']);
  assert.deepEqual(point.requiredServiceTitles, ['身體60', '身體120']);
  assert.equal(point.requiredServiceRequirementLabel, '需預約「身體」項目類型');
  assert.match(point.conditionLabel, /預約項目限制：需預約「身體」項目類型/);
  assert.doesNotMatch(point.conditionLabel, /身體60、身體120/);
});

test('all-mode requires every selected service and labels a full service type accordingly', async () => {
  const { loadBookingBenefits } = await modulePromise;
  const result = await loadBookingBenefits(database({
    point_card_rewards: [{
      id: 'reward',
      point_card_id: 'card',
      ticket_template_id: 'template',
      threshold_stamps: 5,
      required_service_ids: ['service-body-60', 'service-body-120'],
      required_service_match_mode: 'all',
    }],
    booking_services: [
      { id: 'service-body-60', title: '身體60', service_type: '身體' },
      { id: 'service-body-120', title: '身體120', service_type: '身體' },
    ],
  }), member, 'silver', today);
  const point = result.items.find(item => item.kind === 'points');
  assert.ok(point);
  assert.equal(point.requiredServiceMatchMode, 'all');
  assert.equal(point.requiredServiceRequirementLabel, '需預約「身體」項目類型的所有項目');
  assert.match(point.conditionLabel, /需預約「身體」項目類型的所有項目/);
});

test('unclaimed event tickets are selectable by claiming from the booking surface', async () => {
  const { loadBookingBenefits } = await modulePromise;
  const result = await loadBookingBenefits(database(), member, 'silver', today);
  const event = result.items.find(item => item.kind === 'event');
  assert.ok(event);
  assert.equal(event.selectable, true);
  assert.equal(event.claimRequired, true);
  assert.equal(event.selectionId, '');
  assert.match(event.subtitle, /勾選即代表領取/);
  assert.match(event.conditionLabel, /每日最多使用 2 張/);
});

test('birthday activities and claimed inventory preserve existing eligibility rules', async () => {
  const { loadBookingBenefits } = await modulePromise;
  const birthdayActivity = { calendar_item_id: 'CAL', item_type: 'event', status: 'targeted', audience_type: 'birthday_month', audience_month: 1, starts_on: today, ends_on: today };
  const result = await loadBookingBenefits(database({ calendar_items: [birthdayActivity], event_tickets: [{ id: 'event', event_ticket_id: 'EVENT', status: 'active', allowed_tier_keys: ['silver'], quota: 1 }], event_ticket_claims: [{ claim_id: 'EC-001', member_id: member.id, event_ticket_id: 'event', status: 'claimed' }] }), member, 'silver', today);
  assert.equal(result.items.find(item => item.kind === 'event').statusLabel, '可使用');
  assert.equal(result.items.find(item => item.kind === 'event').selectionId, 'EC-001');
  assert.equal(result.items.find(item => item.kind === 'event').selectable, true);
  const activity = result.items.find(item => item.kind === 'calendar');
  assert.ok(activity);
  assert.equal(activity.selectable, false);
  assert.equal(activity.selectionId, '');
  assert.equal((await loadBookingBenefits(database({ calendar_items: [birthdayActivity], event_tickets: [], point_tickets: [] }), { ...member, birthday: '1990-02-01' }, 'silver', today)).items.length, 0);
});

test('reads are member-scoped, batched and strict on backend failure', async () => {
  const { loadBookingBenefits } = await modulePromise;
  const db = database();
  await loadBookingBenefits(db, member, 'silver', today);
  for (const table of ['point_tickets', 'point_balances', 'event_ticket_claims']) assert.ok(db.calls.some(call => call.table === table && call.key === 'member_id' && call.value === member.id));
  assert.equal(db.calls.filter(call => call.read).length, 13);
  for (const fail of ['point_tickets', 'point_balances', 'booking_benefit_selections', 'booking_receipts', 'event_ticket_claim_counts', 'calendar_items', 'event_ticket_settings', 'point_card_settings']) await assert.rejects(loadBookingBenefits(database({}, fail), member, 'silver', today));
});

test('API authorization resolves membership/tier from identity and rejects disabled/unjoined/stale-consent members', async () => {
  const { loadBookingBenefits } = await modulePromise;
  const source = fs.readFileSync(path.join(root, 'supabase/functions/api/index.ts'), 'utf8').replace(/^import .*\n/gm, '').replace(/^export default .*;\s*$/gm, '');
  for (const [patch, consent, code] of [[{}, true, ''], [{ status: 'disabled' }, true, 'MEMBER_DISABLED'], [{ membership_status: 'pending' }, true, 'MEMBERSHIP_REQUIRED'], [{}, false, 'TERMS_RECONSENT_REQUIRED']]) {
    const context = vm.createContext({ Deno: { env: { get: () => '' } }, Date, Intl, Set, Map, console, loadBookingBenefits, hasCurrentTermsConsent: async () => consent });
    vm.runInContext(stripTypeScriptTypes(source), context);
    const pending = context.handleAction(database({ members: [{ ...member, ...patch }] }), { lineUserId: member.line_user_id }, 'user.booking.benefits', { memberId: 'other', tierKey: 'platinum' });
    if (code) await assert.rejects(pending, error => error.code === code);
    else assert.equal((await pending).items.length, 3);
  }
});

 test('higher tier previews stay locked in both ticket and calendar recommendations',async()=>{
 const {loadBookingBenefits}=await modulePromise;
 const result=await loadBookingBenefits(database({event_ticket_settings:[{id:1,visibility_policy:'higher_preview'}],event_tickets:[{id:'event',title:'Gold',status:'active',allowed_tier_keys:['gold']}],calendar_items:[{calendar_item_id:'CAL',title:'Gold activity',status:'active',item_type:'event',starts_on:today,ends_on:today,allowed_tier_keys:['gold']}]}),member,'silver',today);
 for(const item of result.items.filter(x=>x.kind!=='points')){assert.equal(item.statusLabel,'需升級');assert.notEqual(item.selectable,true);assert.match(item.subtitle,/金級/);}
 const downgraded=await loadBookingBenefits(database({event_ticket_settings:[{id:1,visibility_policy:'eligible_only'}],event_tickets:[{id:'event',status:'active',allowed_tier_keys:['gold']}],calendar_items:[]}),member,'silver',today);assert.equal(downgraded.items.filter(x=>x.kind==='event').length,0);
 });

test('booking ticket metadata carries the global claimed count without exposing other owners', async () => {
  const { loadBookingBenefits } = await modulePromise;
  const result = await loadBookingBenefits(database({ event_ticket_claims: [{ event_ticket_id: 'event', member_id: 'other', status: 'used' }] }), member, 'silver', today);
  const event = result.items.find(item => item.kind === 'event');
  assert.equal(event.quota, 2);
  assert.equal(event.claimedCount, 1);
  assert.equal(event.selectionId, '');
  assert.equal(JSON.stringify(event).includes('other'), false);
});
