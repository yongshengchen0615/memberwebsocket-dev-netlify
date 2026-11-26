const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const api = read('supabase/functions/api/index.ts');
const overview = read('points/pointcard-ticket-overview.js');

function fromSource(source, signature, nextSignature, context = {}) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.ok(start !== -1 && end > start, 'production function must be present: ' + signature);
  const name = signature.match(/function (\w+)\(/)[1];
  return vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + '\n' + name, context);
}

test('AC-001: point-card bootstrap resolves reward-specific service restrictions using the existing catalog', () => {
  assert.match(api, /const pointRequiredServiceIds =/);
  assert.match(api, /supabase\.from\("booking_services"\)\.select\("id,title"\)\.in\("id",pointRequiredServiceIds\)/);
  assert.match(api, /reward\.requiredServiceRequirementLabel = ticketRequiredServiceLabel\(/);
  assert.match(api, /required_service_groups: reward\.requiredServiceGroups/);
  assert.match(api, /required_service_match_mode: reward\.requiredServiceMatchMode/);
  const label = fromSource(api, 'function ticketRequiredServiceLabel(', '\nfunction ticketBookingAmountLabel(', { Map, Set });
  const names = new Map([['massage', '身體按摩 60 分鐘'], ['foot', '足部保養 30 分鐘']]);
  assert.equal(label({required_service_ids: []}, names), '');
  assert.equal(label({required_service_ids: ['massage']}, names), '需預約「身體按摩 60 分鐘」項目');
  assert.equal(label({required_service_ids: ['massage', 'foot'],required_service_match_mode:'all'}, names),
    '需預約所有指定項目：「身體按摩 60 分鐘、足部保養 30 分鐘」');
  assert.equal(label({required_service_groups:[['massage','foot'],['massage']]}, names),
    '需預約「身體按摩 60 分鐘＋足部保養 30 分鐘」或「身體按摩 60 分鐘」其中一組的所有項目');
  const missing = label({required_service_ids:['missing-id']}, names);
  assert.match(missing, /已停用項目/);
  assert.doesNotMatch(missing, /missing-id/);
});

test('AC-002: each reward node carries its own condition, even before a ticket is redeemable', () => {
  const offersByCard = fromSource(overview, 'function offersByCard(snapshot) {', '\n  function allOffers()', {
    points(value) { return Math.max(0, Number(value || 0)); },
    safeCardStyle() { return 'citrus'; }, Set, Map,
  });
  const rewards = [
    { thresholdStamps: 5, rewardDbId: 'reward-a', rewardTitle: '共用優惠券', requiredServiceRequirementLabel: '需預約「身體按摩 60 分鐘」項目' },
    { thresholdStamps: 10, rewardDbId: 'reward-b', rewardTitle: '共用優惠券', requiredServiceRequirementLabel: '需預約「足部保養 30 分鐘」項目' },
    { thresholdStamps: 15, rewardDbId: 'reward-c', rewardTitle: '一般票券' },
  ];
  const [group] = offersByCard({
    cards: [{cardId:'card-a',title:'集點卡',status:'active',stamps:5,rewards}],
    cardDetails: {},
  });
  assert.equal(group.offers.length, 3);
  assert.equal(group.offers[0].requiredServiceRequirementLabel, rewards[0].requiredServiceRequirementLabel);
  assert.equal(group.offers[1].requiredServiceRequirementLabel, rewards[1].requiredServiceRequirementLabel);
  assert.equal(group.offers[2].requiredServiceRequirementLabel, '');
  assert.equal(group.offers[1].shortage, 5);
});

test('AC-003: only restricted ticket cards render accessible plain-text booking conditions', () => {
  const createElement = fromSource(overview, 'function createBookingRequirement(offer) {', '\n  function render()', {
    document: { createElement(tag) { return {tag, className:'',textContent:''}; } },
  });
  const element = createElement({requiredServiceRequirementLabel:' 需預約「身體按摩 60 分鐘」項目 '});
  assert.equal(element.tag, 'p');
  assert.equal(element.className, 'member-ticket-booking-requirement');
  assert.equal(element.textContent, '預約使用條件：需預約「身體按摩 60 分鐘」項目');
  assert.equal(createElement({requiredServiceRequirementLabel:''}), null);
  assert.equal(createElement({}), null);
  const injection = createElement({requiredServiceRequirementLabel:'<script>alert(1)</script>'});
  assert.equal(injection.textContent, '預約使用條件：<script>alert(1)</script>');
  assert.match(overview, /if \(bookingRequirement\) item\.append\(bookingRequirement\)/);
});

test('AC-004: scoped styling and versioned assets preserve member page display on mobile', () => {
  const css = read('points/pointcard-ticket-overview.css');
  const html = read('points/index.html');
  assert.match(css, /\.member-ticket-booking-requirement/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(html, /pointcard-ticket-overview\.js\?v=[^"]*booking-conditions-20261126-1/);
  assert.match(html, /pointcard-ticket-overview\.css\?v=[^"]*booking-conditions-20261126-1/);
});
