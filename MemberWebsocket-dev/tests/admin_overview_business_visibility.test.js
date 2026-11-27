const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = () => import('../supabase/functions/_shared/business-policy.mjs');
const completeStats = Object.freeze({
  memberCount: 24,
  activeMemberCount: 18,
  activeCardCount: 3,
  activeEventTicketCount: 7,
  todayEntryCount: 20,
});
const features = ({membership = false, points = false, events = false} = {}) =>
  ({membership, points, events, calendar: false, booking: false, integrations: false});
const ctx = (grants) => ({
  slug: 'shop-fixture', name: '隔離測試商家', features: features(grants),
  status: 'active', runtime_schema: 'business_' + 'a'.repeat(32),
});
const bootstrap = {
  members: [{ id: 'A' }], memberPage: { page: 1 },
  cards: [{ id: 'C' }], tickets: [{ id: 'T' }], eventTickets: [{ id: 'E' }],
  calendarItems: [{ id: 'CAL' }], bookingServices: [{ id: 'B' }],
  tierSettings: [{ tierKey: 'general' }], messagePresets: [{ id: 'P' }],
  stats: completeStats,
};

test('AC-OV-001: an authorized merchant bootstrap renders all five server-computed stats, including zero', async () => {
  const {businessBootstrap} = await policy();
  assert.deepEqual(businessBootstrap(bootstrap,ctx({membership:true,points:true,events:true})).stats,completeStats);
  const zero = {...bootstrap,stats:Object.fromEntries(Object.keys(completeStats).map(key => [key,0]))};
  assert.deepEqual(businessBootstrap(zero,ctx({membership:true,points:true,events:true})).stats,zero.stats);
});

test('AC-OV-002: points-only merchant retains ongoing cards and today grant sum without revealing member/event metrics', async () => {
  const {businessBootstrap} = await policy();
  const output = businessBootstrap(bootstrap,ctx({points:true}));
  assert.deepEqual(output.stats,{activeCardCount:3,todayEntryCount:20});
  assert.deepEqual(output.members,[]);
  assert.deepEqual(output.eventTickets,[]);
  assert.deepEqual(output.cards,bootstrap.cards);
});

test('AC-OV-003: event-only merchant can see active event count but not unlicensed totals', async () => {
  const {businessBootstrap} = await policy();
  assert.deepEqual(businessBootstrap(bootstrap,ctx({events:true})).stats,{activeEventTicketCount:7});
  assert.deepEqual(businessBootstrap(bootstrap,ctx({membership:true})).stats,
    {memberCount:24,activeMemberCount:18});
  assert.deepEqual(businessBootstrap(bootstrap,ctx({})).stats,{});
});

test('AC-OV-004: absent, malformed, unknown and inherited source values never bypass the KPI allowlist', async () => {
  const {businessBootstrap} = await policy();
  assert.deepEqual(businessBootstrap({...bootstrap,stats:null},ctx({points:true})).stats,{});
  assert.deepEqual(businessBootstrap({...bootstrap,stats:[]},ctx({points:true})).stats,{});
  assert.deepEqual(businessBootstrap({...bootstrap,stats:{...completeStats,unscopedSecret:42}},ctx({points:true})).stats,
    {activeCardCount:3,todayEntryCount:20});
  const inherited = Object.create({activeCardCount:9000});
  inherited.todayEntryCount = 2;
  assert.deepEqual(businessBootstrap({...bootstrap,stats:inherited},ctx({points:true})).stats,{todayEntryCount:2});
});

test('AC-OV-005: same feature-specific scope is enforced for summary, card, event and integrations responses', async () => {
  const {businessResponse} = await policy();
  for(const action of ['admin.summary','admin.pointcards.list','admin.event-tickets.list','admin.integration-overview']){
    assert.deepEqual(businessResponse({stats:completeStats},ctx({points:true}),action).stats,
      {activeCardCount:3,todayEntryCount:20},action);
    assert.deepEqual(businessResponse({stats:completeStats},ctx({events:true}),action).stats,
      {activeEventTicketCount:7},action);
    assert.deepEqual(businessResponse({stats:completeStats},ctx({}),action).stats,{},action);
  }
  const normal = businessResponse({eventTicket:{eventTicketId:'E'}},ctx({events:true}),'admin.event-tickets.save');
  assert.deepEqual(normal.eventTicket,{eventTicketId:'E'});
});

test('AC-OV-006: business router applies response policy to every statistics-bearing admin API', () => {
  const runtime = fs.readFileSync(path.join(__dirname,'../supabase/functions/_shared/business-runtime.ts'),'utf8');
  for(const action of ['admin.bootstrap','admin.summary','admin.pointcards.list',
    'admin.event-tickets.list','admin.integration-overview']){
    assert.ok(runtime.includes("'" + action + "'"),action + ' response must be scoped before sending to browser');
  }
  assert.match(runtime,/payload\.data\s*=\s*businessResponse\(payload\.data,c,action\)/);
});

test('AC-OV-007: browser binds the preserved stats fields from canonical admin bootstrap and refresh', () => {
  const app=fs.readFileSync(path.join(__dirname,'../admin/app.js'),'utf8');
  for(const [name,field] of [['activeCardCount','activeCardCount'],['activeEventTicketCount','activeEventTicketCount'],['todayEntryCount','todayEntryCount']]){
    assert.match(app,new RegExp('els\\.'+name+'\\.textContent\\s*=\\s*state\\.stats\\.'+field));
  }
  assert.match(app,/state\.stats\s*=\s*result\.stats/);
  assert.match(app,/state\.stats\s*=\s*\{\s*\.\.\.state\.stats,\s*\.\.\.\(result\.stats/);
});
