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
  // PR #488: a higher tier inherits every offer granted to a lower tier.
  const namesByTier = result.tiers.map(tier => tier.offers.map(offer => offer.title).sort());
  assert.deepEqual(namesByTier, [
    ['一般券'],
    ['一般券', '多階級券'].sort(),
    ['一般券', '多階級券', '金級活動'].sort(),
    ['一般券', '多階級券', '白金抽獎券', '金級活動'].sort(),
  ]);
  assert.equal(result.tiers[2].offers.filter(offer => offer.kind === 'activity').length, 1);
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

test('AC-006: compact widget only loads on open, coalesces, and protects against stale tenant/identity responses', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'member/monthly-tier-benefits.js'), 'utf8');
  const requests = [];
  const newNode = (tag) => ({
    tag, children: [], dataset: {}, textContent: '', attributes: {},
    classList: { add() {} },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const target = newNode('div'), tabs = newNode('div'), status = {textContent:''};
  const teaser = {textContent:''}, month = {textContent:''}, button = {disabled:false};
  const selectors = {
    '[data-member-monthly-tier-overview]': target,
    '[data-member-monthly-tier-tabs]': tabs,
    '[data-member-monthly-tier-status]': status,
    '[data-member-monthly-tier-teaser]': teaser,
    '[data-member-monthly-tier-month]': month,
    '[data-member-monthly-tier-reload]': button,
  };
  const listeners = {};
  const root = {
    hidden: false, open: false,
    querySelector: selector => selectors[selector] || null,
    addEventListener(name, fn) { listeners[name] = fn; },
  };
  const window = {
    BusinessContext: {slug:'shop-a'},
    MemberSystem: {request: (...args) => new Promise((resolve,reject) => requests.push({args,resolve,reject}))},
    BookingSystem: {monthlyTierBenefits: (...args) => new Promise((resolve,reject) => requests.push({args,resolve,reject,booking:true}))},
  };
  vm.runInNewContext(source, {document:{createElement:newNode}, window, Date, Intl, Promise, JSON, Set, WeakMap, String, Number, Error, Object});
  const config = {supabaseUrl:'https://example.supabase.co',business:'shop-a'};
  const member = {lineUserId:'A',tierKey:'silver',status:'active',profileComplete:true,membershipRequired:false};
  await window.MemberMonthlyTierBenefits.bind(root,config,'token1',member,'member');
  assert.equal(requests.length,0,'closed widget must not issue requests');
  root.open = true;
  listeners.toggle();
  assert.equal(requests.length,1,'first expansion requests one catalogue');
  const same = window.MemberMonthlyTierBenefits.bind(root,config,'token1',member,'member');
  assert.equal(requests.length,1,'concurrent refresh coalesces identical requests');
  const second = window.MemberMonthlyTierBenefits.bind(root,config,'token2',{...member,lineUserId:'B'},'member');
  assert.equal(requests.length,2,'switching identity starts a fresh request');
  requests[0].resolve({month:'2026-11',tiers:[{key:'silver',label:'銀級',offers:[{title:'OLD',kind:'ticket'}]}]});
  await Promise.resolve(); await Promise.resolve();
  assert.equal(target.children.length,0,'old member must not render after identity changes');
  requests[1].resolve({month:'2026-11',tiers:[
    {key:'general',label:'一般',offers:[]},
    {key:'silver',label:'銀級',offers:[{title:'<script>alert(1)</script>',kind:'ticket'}]},
    {key:'gold',label:'金級',offers:[]},
    {key:'platinum',label:'白金',offers:[]}
  ]});
  await Promise.all([same,second]);
  assert.equal(target.children.length,1,'only selected tier is rendered');
  assert.equal(tabs.children.length,4,'four tier switches are available');
  assert.equal(target.children[0].children[1].children[0].children[1].textContent,'<script>alert(1)</script>','offer titles remain plain text');
  assert.equal(button.disabled,false);
  assert.equal(teaser.textContent,'收合內容','expanded panel must advertise how to close it');
  tabs.children[0].onclick();
  assert.equal(target.children[0].dataset.tierKey,'general');
  window.BusinessContext.slug='shop-b';
  const third = window.MemberMonthlyTierBenefits.bind(root,config,'token2',{...member,lineUserId:'B'},'member');
  assert.equal(requests.length,3);
  requests[2].reject(new Error('down'));
  await third;
  assert.match(status.textContent,/載入失敗/);
  assert.equal(target.children.length,0,'failed tenant reload clears old tenant data');
  await window.MemberMonthlyTierBenefits.bind(root,config,'token2',{...member,status:'suspended',lineUserId:'B'},'member');
  assert.equal(root.hidden,true);
  assert.equal(target.children.length,0);
  assert.equal(requests.length,3,'inactive member must never fetch benefits');
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

test('AC-010: monthly list does not create or update membership records', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/member-profile-api/index.ts'), 'utf8');
  const existing = api.slice(api.indexOf('async function existingMemberForCatalogue'), api.indexOf('async function tierSettings'));
  assert.match(existing, /\.select\("\*"\)/);
  assert.match(existing, /MEMBERSHIP_REQUIRED/);
  assert.doesNotMatch(existing, /\.insert\(|\.update\(|\.delete\(/);
  assert.match(api, /action === "user\.member\.monthly-tier-benefits"[\s\S]*?existingMemberForCatalogue\(supabase, identity\)[\s\S]*?: await ensureMember\(supabase, identity\)/);
});

test('AC-011: activity without end date is one day, while ticket without end date remains open-ended', async () => {
  const { buildMonthlyTierOverview } = await load();
  const activities = [
    {title:'十月單日活動',item_type:'event',status:'active',starts_on:'2026-10-15',ends_on:null,allowed_tier_keys:['general']},
    {title:'十一月單日活動',item_type:'event',status:'active',starts_on:'2026-11-15',ends_on:null,allowed_tier_keys:['general']},
    {title:'跨月活動',item_type:'event',status:'active',starts_on:'2026-10-29',ends_on:'2026-11-03',allowed_tier_keys:['general']},
  ];
  const tickets = [
    {title:'持續有效券',ticket_type:'coupon',status:'active',starts_on:'2026-10-01',ends_on:null,allowed_tier_keys:['general']},
  ];
  const nov = buildMonthlyTierOverview({month:'2026-11',activities,tickets}).tiers[0].offers;
  assert.ok(!nov.some(item=>item.title==='十月單日活動'), 'single-day event must not remain available after October');
  assert.ok(nov.some(item=>item.title==='十一月單日活動'));
  assert.equal(nov.find(item=>item.title==='十一月單日活動')?.endsOn, '2026-11-15', 'single-day display uses start date as end date');
  assert.ok(nov.some(item=>item.title==='跨月活動'));
  assert.ok(nov.some(item=>item.title==='持續有效券'), 'tickets may remain open ended');
  const dec = buildMonthlyTierOverview({month:'2026-12',activities,tickets}).tiers[0].offers;
  assert.deepEqual(dec.map(item=>item.title), ['持續有效券']);
  const api = fs.readFileSync(path.join(__dirname, '..', 'supabase/functions/member-profile-api/index.ts'), 'utf8');
  assert.match(api, /ends_on\.gte\.\$\{start\},and\(ends_on\.is\.null,starts_on\.gte\.\$\{start\}\)/);
});

test('AC-012: four tier cards inherit lower tier tickets and activities exactly as shared eligibility', async () => {
  const { buildMonthlyTierOverview, MONTHLY_TIERS } = await load();
  const { tierEligible } = await import('../supabase/functions/_shared/tier-visibility.ts');
  for (const minimum of MONTHLY_TIERS) {
    const ticket = {title:'券-'+minimum.key,ticket_type:'coupon',status:'active',starts_on:'2026-11-01',ends_on:'2026-11-30',allowed_tier_keys:[minimum.key]};
    const activity = {title:'活動-'+minimum.key,item_type:'event',status:'active',starts_on:'2026-11-15',ends_on:null,allowed_tier_keys:[minimum.key]};
    const result = buildMonthlyTierOverview({month:'2026-11',tickets:[ticket],activities:[activity]});
    for (const tier of result.tiers) {
      const entitled = tierEligible([minimum.key], tier.key);
      assert.equal(tier.offers.some(offer=>offer.title===ticket.title),entitled,`ticket inheritance ${minimum.key} → ${tier.key}`);
      assert.equal(tier.offers.some(offer=>offer.title===activity.title),entitled,`event inheritance ${minimum.key} → ${tier.key}`);
      assert.equal(tier.offers.length,entitled?2:0,`no duplicates for ${minimum.key} → ${tier.key}`);
    }
  }
  const both = buildMonthlyTierOverview({month:'2026-11',tickets:[
    {title:'複數階級券',ticket_type:'coupon',status:'active',starts_on:'2026-11-01',ends_on:null,allowed_tier_keys:['silver','gold']},
  ]});
  assert.deepEqual(both.tiers.map(t => t.offers.length), [0,1,1,1], 'multiple allowed minimums must not duplicate a single offer');
});

test('AC-013: all five member-facing portals embed the same closed compact monthly disclosure', () => {
  const root = path.resolve(__dirname, '..');
  for (const surface of ['member','points','event','calendar','booking']) {
    const html = fs.readFileSync(path.join(root,surface,'index.html'),'utf8');
    const app = fs.readFileSync(path.join(root,surface,'app.js'),'utf8');
    assert.match(html, /<details class="member-monthly-benefits" data-member-monthly-tier-widget/);
    assert.match(html, /data-member-monthly-tier-tabs/);
    assert.match(html, /data-member-monthly-tier-overview/);
    assert.match(html, /monthly-tier-benefits\.css/);
    assert.match(html, /monthly-tier-benefits\.js/);
    assert.match(app, /MemberMonthlyTierBenefits\?\.bind/);
    assert.equal((html.match(/data-member-monthly-tier-widget/g)||[]).length,1,surface+' must not duplicate widget');
    assert.doesNotMatch(html, /<details class="member-monthly-benefits"[^>]*\bopen\b/);
    assert.doesNotMatch(html, /data-monthly-ticket-claim/);
  }
  for (const surface of ['admin','platform','frontdesk']) {
    const html = fs.readFileSync(path.join(root,surface,'index.html'),'utf8');
    assert.doesNotMatch(html, /data-member-monthly-tier-widget/);
  }
});

test('AC-014: catalogue API authorizes only five matching user surfaces; other member APIs remain member-only', () => {
  const root = path.resolve(__dirname, '..');
  const api = fs.readFileSync(path.join(root,'supabase/functions/member-profile-api/index.ts'),'utf8');
  const system = fs.readFileSync(path.join(root,'member-system.js'),'utf8');
  const booking = fs.readFileSync(path.join(root,'booking/common.js'),'utf8');
  assert.match(api,/const catalogueSurfaces = \["member", "points", "event", "calendar", "booking"\]/);
  assert.match(api,/isCatalogue \? !catalogueSurfaces\.includes\(clientType\) : clientType !== "member"/);
  assert.match(api,/isCatalogue && testIdentity\.surface !== clientType/);
  assert.match(api,/existingMemberForCatalogue\(supabase, identity\)/);
  assert.match(system,/\['points', 'event', 'calendar'\]\.includes\(clientType\) && action === 'user\.member\.monthly-tier-benefits'/);
  assert.match(booking,/async function monthlyTierBenefits\(config, idToken\)/);
  assert.match(booking,/action: 'user\.member\.monthly-tier-benefits', clientType: 'booking', idToken/);
  assert.match(booking,/\/functions\/v1\/member-profile-api/);
  assert.doesNotMatch(booking.slice(booking.indexOf('async function monthlyTierBenefits'),booking.indexOf('async function memberProfile')),/\.insert\(|\.update\(|\.delete\(/);
});

test('AC-015: widget uses no automatic bootstrap read while closed and preserves business/identity isolation', () => {
  const source = fs.readFileSync(path.join(__dirname,'..','member/monthly-tier-benefits.js'),'utf8');
  assert.match(source,/root\.addEventListener\('toggle'/);
  assert.match(source,/root\.open && state\.ready/);
  assert.match(source,/config\.supabaseUrl, business, idToken, profile\.lineUserId, profile\.tierKey, clientType, currentMonth/);
  assert.match(source,/request !== state\.generation/);
  assert.match(source,/root\.hidden = !permitted/);
  assert.match(source,/const STALE_MS = 120000/);
  assert.doesNotMatch(source,/user\..*ticket\.(?:claim|redeem)|\.innerHTML\s*=/);
});

test('AC-016: monthly catalogue uses shared semantic light/dark theme tokens and short tab names', () => {
  const root = path.resolve(__dirname,'..');
  const css = fs.readFileSync(path.join(root,'member/monthly-tier-benefits.css'),'utf8');
  const js = fs.readFileSync(path.join(root,'member/monthly-tier-benefits.js'),'utf8');
  assert.match(css,/--monthly-surface: var\(--theme-surface-raised/);
  assert.match(css,/--monthly-text: var\(--theme-text/);
  assert.match(css,/html\[data-theme="dark"\] \.member-monthly-benefits/);
  assert.match(css,/prefers-reduced-motion: reduce/);
  assert.match(css,/grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css,/data-member-monthly-tier-reload/);
  assert.match(js,/fullLabel\.replace\(\/會員\$\/, ''\)/);
  assert.match(js,/member-monthly-tab-count/);
  assert.match(js,/aria-label/);
  for (const surface of ['member','points','event','calendar','booking']) {
    const html=fs.readFileSync(path.join(root,surface,'index.html'),'utf8');
    assert.match(html,/monthly-tier-benefits\.css\?v=20261127-card-style-1/);
    assert.match(html,/monthly-tier-benefits\.js\?v=20261127-card-style-1/);
    assert.match(html,/data-member-monthly-tier-teaser>展開查看<\/small>/);
  }
});

test('AC-017: month benefits disclosure has an explicit two-way expand/collapse affordance', () => {
  const root = path.resolve(__dirname,'..');
  const css = fs.readFileSync(path.join(root,'member/monthly-tier-benefits.css'),'utf8');
  const js = fs.readFileSync(path.join(root,'member/monthly-tier-benefits.js'),'utf8');
  assert.match(css,/\.member-monthly-benefits-heading small\s*\{/);
  assert.match(css,/\.member-monthly-benefits-heading::after\s*\{/);
  assert.match(css,/background: var\(--monthly-highlight\)/);
  assert.match(css,/cursor: pointer/);
  assert.match(js,/teaser\.textContent = root\.open \? '收合內容' : '展開查看'/);
  for (const surface of ['member','points','event','calendar','booking']) {
    const html = fs.readFileSync(path.join(root,surface,'index.html'),'utf8');
    assert.match(html,/<summary class="member-monthly-benefits-heading">/);
    assert.match(html,/data-member-monthly-tier-teaser>展開查看<\/small>/);
    assert.equal((html.match(/data-member-monthly-tier-teaser/g)||[]).length,1);
  }
});

test('AC-018: monthly tier names/styles follow tenant membership card settings, not fixed rank colors', async () => {
  const { buildMonthlyTierOverview, MEMBERSHIP_CARD_STYLE_KEYS } = await load();
  const styleKeys = ['forest','midnight','ocean','sunset','lavender','rose','gold','platinum','mint','cherry'];
  assert.deepEqual([...MEMBERSHIP_CARD_STYLE_KEYS], styleKeys);
  const custom = [
    { tier_key:'general',tier_label:'入門卡',style_key:'rose' },
    { tier_key:'silver',tier_label:'進階會員',style_key:'ocean' },
    { tier_key:'gold',tier_label:'尊榮會員',style_key:'cherry' },
    { tier_key:'platinum',tier_label:'最高等級',style_key:'mint' },
  ];
  const result = buildMonthlyTierOverview({month:'2026-11',tierSettings:custom});
  assert.deepEqual(result.tiers.map(t=>t.label),custom.map(t=>t.tier_label));
  assert.deepEqual(result.tiers.map(t=>t.styleKey),custom.map(t=>t.style_key));
  assert.deepEqual(result.tiers.map(t=>t.key),['general','silver','gold','platinum']);
  assert.ok(result.tiers.every(t=>Array.isArray(t.offers)&&t.offers.length===0));
  assert.deepEqual(buildMonthlyTierOverview({month:'2026-11'}).tiers.map(t=>t.styleKey),['forest','forest','forest','forest']);
  const malicious = buildMonthlyTierOverview({month:'2026-11',tierSettings:[
    {tier_key:'silver',tier_label:'',style_key:'some-untrusted-selector'},
    {tier_key:'gold',tier_label:'亂'.repeat(100),style_key:'../../script'},
    {tier_key:'not-a-tier',tier_label:'非法階級',style_key:'rose'},
  ]});
  assert.equal(malicious.tiers[1].label,'銀級會員');
  assert.equal(malicious.tiers[1].styleKey,'forest');
  assert.equal(malicious.tiers[2].label.length,40);
  assert.equal(malicious.tiers[2].styleKey,'forest');
  assert.equal(malicious.tiers.length,4);
  const api=fs.readFileSync(path.join(__dirname,'..','supabase/functions/member-profile-api/index.ts'),'utf8');
  assert.match(api,/profileFor\(supabase, member, true\)/);
  assert.match(api,/tierPresentations: settings\.map/);
  assert.match(api,/tierSettings: Array\.isArray\(viewerProfile\.tierPresentations\)/);
  const section=api.slice(api.indexOf('async function monthlyTierBenefits('),api.indexOf("serveBusiness('member-profile-api'"));
  assert.doesNotMatch(section,/tierSettings\(supabase\)/,'monthly endpoint should reuse already loaded membership-card tier settings');
});

test('AC-019: all 10 monthly tier palettes are exactly the member-card palettes', () => {
  const root=path.resolve(__dirname,'..');
  const card=fs.readFileSync(path.join(root,'member/styles.css'),'utf8');
  const monthly=fs.readFileSync(path.join(root,'member/monthly-tier-benefits.css'),'utf8');
  const js=fs.readFileSync(path.join(root,'member/monthly-tier-benefits.js'),'utf8');
  const cardRules=[...card.matchAll(/\.member-pass\.tier-style-([a-z]+) \{ --pass-background: (#[0-9a-f]{6}); --pass-accent: (#[0-9a-f]{6}); --pass-soft: (#[0-9a-f]{6}); \}/g)];
  assert.equal(cardRules.length,10);
  for(const [,name,bg,accent,soft] of cardRules) {
    const rule = '.member-monthly-benefits :is(.member-monthly-tab, .member-monthly-tier)[data-membership-tier-style="' + name + '"] {\n'
      + '  --monthly-card-background: ' + bg + ';\n'
      + '  --monthly-card-accent: ' + accent + ';\n'
      + '  --monthly-card-soft: ' + soft + ';\n}';
    assert.ok(monthly.includes(rule),'monthly tier '+name+' should match existing member card palette');
  }
  assert.match(monthly,/button\[data-membership-tier-style\]/);
  assert.match(monthly,/\.member-monthly-tier\[data-membership-tier-style\]/);
  assert.match(js,/button\.dataset\.membershipTierStyle = cardStyle\(tier\.styleKey\)/);
  assert.match(js,/section\.dataset\.membershipTierStyle = cardStyle\(tier\.styleKey\)/);
  assert.match(js,/CARD_STYLE_KEYS\.has\(key\) \? key : 'forest'/);
});
