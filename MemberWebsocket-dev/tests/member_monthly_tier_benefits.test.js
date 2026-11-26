'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../supabase/functions/_shared/monthly-tier-benefits.mjs');

test('AC-001: current month is calculated in Asia/Taipei, not server UTC', async () => {
  const { currentTaipeiMonth } = await load();
  assert.equal(currentTaipeiMonth(new Date('2026-11-30T15:59:59Z')), '2026-11');
  assert.equal(currentTaipeiMonth(new Date('2026-11-30T16:00:00Z')), '2026-12');
});

test('AC-002: all four tiers show their matching active monthly tickets and activities', async () => {
  const { buildMonthlyTierOverview } = await load();
  const result = buildMonthlyTierOverview({
    month: '2026-11',
    tickets: [
      { id: 'a', ticket_type: 'coupon', title: '一般券', status: 'active', starts_on: '2026-10-20', ends_on: '2026-11-15', allowed_tier_keys: ['general'] },
      { id: 'b', ticket_type: 'lottery', title: '白金抽獎券', status: 'active', starts_on: '2026-11-01', ends_on: '2026-12-25', allowed_tier_keys: ['platinum'] },
      { id: 'c', ticket_type: 'coupon', title: '多階級券', status: 'active', starts_on: '2026-11-01', ends_on: '2026-11-30', allowed_tier_keys: ['silver','gold'] },
    ],
    activities: [
      { calendar_item_id: 'd', title: '金級活動', item_type: 'event', status: 'active', audience_type: 'all', starts_on: '2026-11-26', ends_on: '2026-11-26', allowed_tier_keys: ['gold'] },
    ],
  });
  assert.equal(result.month, '2026-11');
  assert.deepEqual(result.tiers.map(tier => tier.key), ['general','silver','gold','platinum']);
  assert.deepEqual(result.tiers.map(tier => tier.offers.map(offer => offer.title)),
    [['一般券'],['多階級券'],['多階級券','金級活動'],['白金抽獎券']]);
  assert.deepEqual(result.tiers[2].offers.map(offer => offer.kind), ['ticket','activity']);
});

test('AC-003: exclude expired, future, targeted, unpublished and private issuance templates', async () => {
  const { buildMonthlyTierOverview } = await load();
  const tickets = [
    { title: '去年', ticket_type: 'coupon', status: 'active', starts_on: '2025-01-01', ends_on: '2025-12-31', allowed_tier_keys: ['general'] },
    { title: '下個月', ticket_type: 'coupon', status: 'active', starts_on: '2026-12-01', ends_on: '2026-12-31', allowed_tier_keys: ['general'] },
    { title: '停用', ticket_type: 'coupon', status: 'inactive', starts_on: '2026-11-01', ends_on: '2026-11-30', allowed_tier_keys: ['general'] },
    { title: '私人好友券', ticket_type: 'referral', status: 'active', starts_on: '2026-11-01', ends_on: '2026-11-30', allowed_tier_keys: ['general'] },
    { title: '入會券', ticket_type: 'membership_join', status: 'active', starts_on: '2026-11-01', ends_on: '2026-11-30', allowed_tier_keys: ['general'] },
    { title: '固定模板', ticket_type: 'coupon', status: 'active', fixed_ticket_template_id: 'template', starts_on: '2026-11-01', ends_on: '2026-11-30', allowed_tier_keys: ['general'] },
    { title: '已刪除', ticket_type: 'coupon', status: 'active', deleted_at: '2026-11-01', starts_on: '2026-11-01', ends_on: '2026-11-30', allowed_tier_keys: ['general'] },
    { title: '未設定階級', ticket_type: 'coupon', status: 'active', starts_on: '2026-11-01', ends_on: '2026-11-30', allowed_tier_keys: [] },
  ];
  const activities = [
    { title: '生日限定', item_type: 'event', status: 'targeted', audience_type: 'birthday_month', starts_on: '2026-11-01', ends_on: '2026-11-30', allowed_tier_keys: ['general'] },
    { title: '票券日曆重複', item_type: 'event', status: 'active', audience_type: 'all', source_event_ticket_id: 'uuid', starts_on: '2026-11-01', ends_on: '2026-11-30', allowed_tier_keys: ['general'] },
    { title: '休假', item_type: 'holiday', status: 'active', starts_on: '2026-11-01', ends_on: '2026-11-30', allowed_tier_keys: ['general'] },
  ];
  const result = buildMonthlyTierOverview({ month: '2026-11', tickets, activities });
  assert.ok(result.tiers.every(tier => tier.offers.length === 0));
});

test('AC-004: legacy calendar activity with no tier restriction appears in each tier; feature scope can disable collections', async () => {
  const { buildMonthlyTierOverview } = await load();
  const activity = { title:'公開會員活動', item_type:'event', status:'active', starts_on:'2026-11-01', ends_on:'2026-11-30', allowed_tier_keys:[] };
  const ticket = { title:'金級券', ticket_type:'coupon', status:'active', starts_on:'2026-11-01', ends_on:'2026-11-30', allowed_tier_keys:['gold'] };
  const result = buildMonthlyTierOverview({month:'2026-11',tickets:[ticket],activities:[activity],showTickets:false});
  assert.deepEqual(result.tiers.map(tier => tier.offers.map(offer => offer.title)),
    [['公開會員活動'],['公開會員活動'],['公開會員活動'],['公開會員活動']]);
});

test('AC-005: member screen loads an authenticated read-only catalogue but has no claim action', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'member/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'member/app.js'), 'utf8');
  const router = fs.readFileSync(path.join(root, 'member-system.js'), 'utf8');
  const endpoint = fs.readFileSync(path.join(root, 'supabase/functions/member-profile-api/index.ts'), 'utf8');
  assert.match(html, /data-member-monthly-tier-overview/);
  assert.match(html, /monthly-tier-benefits\.js/);
  assert.match(app, /MemberMonthlyTierBenefits/);
  assert.match(router, /user\.member\.monthly-tier-benefits/);
  assert.match(endpoint, /user\.member\.monthly-tier-benefits/);
  assert.match(endpoint, /member\.status !== "active"/);
  assert.doesNotMatch(html, /data-monthly-ticket-claim/);
});

test('AC-006: coalesced requests, tenant switching, stale results and text-only titles', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'member/monthly-tier-benefits.js'), 'utf8');
  const requests = [];
  const target = { children: [], replaceChildren(...items) { this.children = items; }, setAttribute() {} };
  const status = { textContent: '' }, month = { textContent: '' }, button = { disabled: false };
  const selectors = {
    '[data-member-monthly-tier-overview]': target,
    '[data-member-monthly-tier-status]': status,
    '[data-member-monthly-tier-month]': month,
    '[data-member-monthly-tier-reload]': button,
  };
  const document = { createElement: (tag) => {
    const item = {tag, children: [], dataset: {}, className: '', textContent: '', classList: { add() {} },
      append(...nodes) { this.children.push(...nodes); } };
    return item;
  }};
  const window = { BusinessContext: { slug: 'shop-a' }, MemberSystem: {
    request: (...args) => new Promise((resolve, reject) => { requests.push({ args, resolve, reject }); }),
  }};
  vm.runInNewContext(source, {document, window, Promise, Date, Intl, JSON});
  const root = { querySelector: (selector) => selectors[selector] || null };
  const config = { supabaseUrl: 'https://example.supabase.co', business: 'shop-a' };
  const member = {lineUserId:'A',tierKey:'general',status:'active',profileComplete:true,membershipRequired:false};
  const first = window.MemberMonthlyTierBenefits.refresh(root, config, 'token1', member);
  assert.strictEqual(window.MemberMonthlyTierBenefits.refresh(root, config, 'token1', member), first);
  assert.equal(requests.length, 1);
  const second = window.MemberMonthlyTierBenefits.refresh(root, config, 'token2', {...member,lineUserId:'B'});
  requests[0].resolve({month:'2026-11',tiers:[{key:'general',label:'一般',offers:[{title:'old',kind:'ticket'}]}]});
  await first;
  assert.equal(target.children.length, 0, 'stale response cannot render another member data');
  requests[1].resolve({month:'2026-11',tiers:[{key:'general',label:'一般',offers:[{title:'<script>alert(1)</script>',kind:'ticket'}]}]});
  await second;
  assert.equal(target.children[0].children[1].children[0].children[1].textContent,'<script>alert(1)</script>');
  assert.equal(button.disabled, false);
  window.BusinessContext.slug = 'shop-b';
  const third = window.MemberMonthlyTierBenefits.refresh(root, config, 'token2', {...member,lineUserId:'B'});
  assert.equal(requests.length, 3);
  requests[2].reject(new Error('unavailable'));
  await third;
  assert.match(status.textContent, /載入失敗/);
  assert.equal(target.children.length, 0, 'failed new tenant request cannot show old tenant data');
});

test('AC-007: inactive membership and unrelated modules cannot leak benefits', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'member/monthly-tier-benefits.js'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/member-profile-api/index.ts'), 'utf8');
  assert.match(js, /profile\?\.membershipRequired/);
  assert.match(api, /member\.status !== "active" \|\| member\.membership_status !== "active"/);
  assert.match(api, /showTickets = !features \|\| features\.events === true/);
  assert.match(api, /showActivities = !features \|\| features\.calendar === true/);
  assert.match(api, /TERMS_RECONSENT_REQUIRED/);
});

test('AC-008: open-ended active ticket has a matching month; SQL honours nullable starts_on', async () => {
  const { buildMonthlyTierOverview } = await load();
  const benefit = {title:'常態優惠',ticket_type:'coupon',status:'active',starts_on:null,ends_on:null,allowed_tier_keys:['general']};
  const result = buildMonthlyTierOverview({month:'2026-11',tickets:[benefit]});
  assert.deepEqual(result.tiers[0].offers.map(item => item.title), ['常態優惠']);
  const api = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/member-profile-api/index.ts'), 'utf8');
  assert.match(api, /starts_on\.is\.null,starts_on\.lte/);
  assert.match(api, /ends_on\.is\.null,ends_on\.gte/);
});

test('AC-009: private higher-tier titles obey tier visibility while opt-in previews remain read-only', async () => {
  const { tierVisibility } = await import('../supabase/functions/_shared/tier-visibility.ts');
  assert.equal(tierVisibility(['platinum'], 'general', 'eligible_only').visible, false);
  assert.equal(tierVisibility(['platinum'], 'general', 'higher_preview').visible, true);
  assert.equal(tierVisibility(['platinum'], 'platinum', 'eligible_only').visible, true);
  const api = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/member-profile-api/index.ts'), 'utf8');
  assert.match(api, /tierVisibility\(keys, viewerProfile\.tierKey, row\.visibility_policy \|\| defaultVisibilityPolicy\)\.visible/);
  assert.match(api, /loadVisibilityPolicy\(supabase\)/);
  assert.match(api, /TEST_SESSION_SURFACE_MISMATCH/);
});
