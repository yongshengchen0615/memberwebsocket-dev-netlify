const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/api/index.ts'), 'utf8')
  .replace(/^import .*\n/gm, '').replace(/^export default .*;\s*$/gm, '');
function api() {
  const requireActiveAdminContract = async ({ supabase, identity, createError }) => {
    const result = await supabase.from('admins').select('*').eq('line_user_id', identity.lineUserId).maybeSingle();
    if (result.error) throw createError(500, 'DATABASE_ERROR', 'admin lookup failed');
    if (!result.data || result.data.role !== 'admin' || result.data.status !== 'active') {
      throw createError(403, 'ADMIN_PENDING', 'admin authorization required');
    }
    return result.data;
  };
  const verifyLineIdTokenContract = async ({ idToken, createError }) => {
    if (!idToken) throw createError(401, 'AUTH_REQUIRED', 'login required');
    return identity;
  };
  const context = vm.createContext({
    Deno: { serve() {}, env: { get() { return ''; } } },
    Date, Intl, Set, Map, console, crypto: require('node:crypto').webcrypto, TextEncoder,
    requireActiveAdminContract, verifyLineIdTokenContract,
    hasCurrentTermsConsent: async () => true,
  });
  vm.runInContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../supabase/functions/_shared/tier-visibility.ts'),'utf8').replace(/^import .*\n/gm,'').replace(/^export /gm,'')),context);
  const usage=fs.readFileSync(path.join(__dirname,'../supabase/functions/_shared/booking-ticket-usage.ts'),'utf8').replace(/^export /gm,'');
  vm.runInContext(stripTypeScriptTypes(usage),context);
  vm.runInContext(stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../supabase/functions/_shared/booking-selection-context.ts'),'utf8').replace(/^import .*\n/gm,'').replace(/^export /gm,'')),context);
  vm.runInContext(stripTypeScriptTypes(source), context); return context;
}
const member = { id: 'member-A', line_user_id: 'line-A', display_name: 'Fixture', membership_status: 'active', status: 'active', is_test_account: false };
const identity = { lineUserId: member.line_user_id, displayName: member.display_name };
const card = { id: 'card-uuid', card_id: 'CARD', title: 'Card', status: 'active' };
const event = { id: 'event-uuid', event_ticket_id: 'EVENT', title: 'Event', status: 'active', quota: 3, allowed_tier_keys: ['general'] };
const fixture = {
  members: [member], admins: [{ line_user_id: 'line-A', role: 'admin', status: 'active', display_name: 'Fixture' }],
  membership_tier_settings: [{ tier_key: 'general', tier_label: '一般會員', required_service_minutes: 0 }],
  service_time_entries: [{ member_id: member.id, minutes: 40 }, { member_id: member.id, minutes: 10 }, { member_id: 'other', minutes: 999 }],
  point_cards: [card], point_balances: [{ member_id: member.id, point_card_id: card.id, stamps: 5 }],
  point_tickets: [{ member_id: member.id, point_card_id: card.id, ticket_id: 'AVAILABLE', status: 'available' }, { member_id: member.id, point_card_id: card.id, ticket_id: 'USED', status: 'used', points_spent: 2 }],
  event_tickets: [event], event_ticket_claims: [
    { member_id: 'other', event_ticket_id: event.id, claim_id: 'OTHER', status: 'available' },
    { member_id: member.id, event_ticket_id: 'archived-event', claim_id: 'HISTORY', status: 'used', event_tickets: { event_ticket_id: 'OLD' } },
  ],
};
function database({ rows = {}, errorTable, hold = () => false } = {}) {
  const calls = [], releases = [], writes = [];
  const data = { ...fixture, ...rows };
  const client = { calls, releases, writes, from(table) {
    const filters = []; let single = false, options, columns;
    const q = { select(value, opts) { columns = value; options = opts; return q; },
      eq(key, value) { filters.push(row => row[key] === value); return q; },
      in(key, values) { filters.push(row => values.includes(row[key])); return q; },
      is(key, value) { filters.push(row => value === null ? row[key] == null : row[key] === value); return q; },
      single() { single = true; return q; }, maybeSingle() { single = true; return q; },
      insert() { writes.push(table); return q; }, update() { writes.push(table); return q; },
      then(resolve, reject) {
        calls.push({ table, columns });
        const selected = (data[table] || []).filter(row => filters.every(filter => filter(row)));
        const result = { data: options?.head ? null : single ? selected[0] || null : selected, count: selected.length, error: table === errorTable ? { message: 'fixture database failure' } : null };
        const promise = hold(table, columns) ? new Promise(done => releases.push(() => done(result))) : Promise.resolve(result);
        return promise.then(resolve, reject);
      },
    };
    for (const method of ['order', 'range', 'gte', 'gt', 'or', 'limit']) q[method] = () => q;
    return q;
  }, rpc(name, args) {
    calls.push({ table: name, args });
    if (name === 'member_ticket_booking_options') return Promise.resolve({data: data.bookingOptions || {points:{},event:{}}, error:name===errorTable?{message:'fixture database failure'}:null});
    if (name === 'member_service_minute_totals') {
      const totals = args.p_member_ids.map(member_id => ({ member_id, total_minutes: (data.service_time_entries || []).filter(row => row.member_id === member_id).reduce((sum, row) => sum + row.minutes, 0) }));
      const result = { data: totals, error: name === errorTable ? { message: 'fixture database failure' } : null };
      return hold(name) ? new Promise(resolve => releases.push(() => resolve(result))) : Promise.resolve(result);
    }
    if (name === 'event_ticket_claim_counts') {
      const counts = new Map();
      for (const claim of data.event_ticket_claims || []) {
        if (args.p_event_ids.includes(claim.event_ticket_id)) counts.set(claim.event_ticket_id, (counts.get(claim.event_ticket_id) || 0) + 1);
      }
      return Promise.resolve({ data: [...counts].map(([event_ticket_id, claimed_count]) => ({ event_ticket_id, claimed_count })), error: null });
    }
    return hold(name) ? new Promise(resolve => releases.push(() => resolve({ error: null }))) : Promise.resolve({ error: null });
  } }; return client;
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('profile reads start together, retain member isolation and produce correct totals', async () => {
  const db = database({ hold: () => true }); const pending = api().profileFor(db, member);
  await flush(); assert.deepEqual(db.calls.map(c => c.table).sort(), ['member_service_minute_totals', 'membership_tier_settings']);
  db.releases.forEach(release => release()); const profile = await pending;
  assert.equal(profile.serviceMinutesTotal, 50); assert.equal(profile.lineUserId, 'line-A');
});
test('admin bootstrap queries tiers once and returns all required sections', async () => {
  const db = database(); const result = await api().handleAction(db, identity, 'admin.bootstrap', {});
  assert.equal(db.calls.filter(c => c.table === 'membership_tier_settings').length, 1);
  for (const key of ['members', 'tierSettings', 'cards', 'tickets', 'eventTickets', 'calendarItems', 'messagePresets']) assert.ok(Array.isArray(result[key]), key);
  assert.equal(result.members[0].serviceMinutesTotal, 50); assert.equal(result.role, 'Admin');
  assert.ok(result.memberPage); assert.ok(result.stats);
});
test('point balance and ticket reads wait for issuance, then start together', async () => {
  const db = database({ hold: table => ['issue_eligible_point_tickets_for_member', 'point_balances', 'point_tickets'].includes(table) });
  const pending = api().pointBootstrap(db, member); await flush();
  assert.equal(db.calls.filter(c => c.table === 'issue_eligible_point_tickets_for_member').length, 1);
  assert.equal(db.calls.filter(c => ['point_balances', 'point_tickets'].includes(c.table)).length, 0);
  db.releases.shift()(); await flush();
  assert.equal(db.calls.filter(c => ['point_balances', 'point_tickets'].includes(c.table)).length, 2);
  db.releases.forEach(release => release()); const result = await pending;
  assert.equal(result.cards[0].stamps, 5); assert.equal(result.cardDetails.CARD.tickets[0].ticketId, 'AVAILABLE');
  assert.equal(result.history[0].ticketId, 'USED'); assert.equal(result.history[0].cardTitle, 'Card'); assert.equal(result.history[0].pointsSpent, 2);
});
test('empty active cards skip identity lookup and issuance', async () => {
  const db = database({ rows: { point_cards: [{ ...card, status: 'draft' }] } });
  const result = await api().pointBootstrap(db, member);
  assert.equal(result.cards.length, 0); assert.equal(result.historyTotal, 0);
  assert.equal(db.calls.filter(c => c.table === 'point_cards').length, 1);
  assert.equal(db.calls.filter(c => c.table === 'issue_eligible_point_tickets_for_member').length, 0);
});
test('event bootstrap keeps quota counts, member-only claims and archived used history', async () => {
  const result = await api().eventBootstrap(database(), member);
  assert.equal(result.offers[0].claim, null); assert.equal(result.offers[0].canClaim, true);
  assert.equal(result.offers[0].ticket.claimedCount, 1); assert.equal(result.usedTicketCount, 1);
  assert.equal(result.usedTickets[0].claim.claimId, 'HISTORY'); assert.equal(result.usedTickets[0].ticket.eventTicketId, 'OLD');
});
test('event bootstrap exposes fixed tickets only to members who own the issued claim', async () => {
  const issued = { ...event, id: 'fixed-issued', event_ticket_id: 'FIXED-ISSUED', title: 'Issued Fixed', fixed_ticket_template_id: 'template-A' };
  const unissued = { ...event, id: 'fixed-unissued', event_ticket_id: 'FIXED-UNISSUED', title: 'Unissued Fixed', fixed_ticket_template_id: 'template-B' };
  const rows = {
    event_tickets: [event, issued, unissued],
    event_ticket_claims: [
      { member_id: member.id, event_ticket_id: issued.id, claim_id: 'FIXED-CLAIM', status: 'claimed', ticket_type: 'coupon', ticket_title: 'Issued Fixed' },
      { member_id: member.id, event_ticket_id: 'archived-event', claim_id: 'HISTORY', status: 'used', event_tickets: { event_ticket_id: 'OLD' } },
    ],
  };
  const result = await api().eventBootstrap(database({ rows }), member);
  assert.deepEqual(result.offers.map(offer => offer.ticket.eventTicketId), ['EVENT', 'FIXED-ISSUED']);
  assert.equal(result.offers[1].claim.claimId, 'FIXED-CLAIM');
  assert.equal(result.offers.some(offer => offer.ticket.eventTicketId === 'FIXED-UNISSUED'), false);
});
test('no active events still returns historical tickets and skips active-claim queries', async () => {
  const db = database({ rows: { event_tickets: [] } }); const result = await api().eventBootstrap(db, member);
  assert.equal(result.offers.length, 0); assert.equal(result.usedTicketCount, 1);
  assert.equal(db.calls.filter(c => c.table === 'event_ticket_claims').length, 1);
});
for (const [fn, table] of [['profileFor', 'membership_tier_settings'], ['profileFor', 'member_service_minute_totals'], ['pointBootstrap', 'point_balances'], ['pointBootstrap', 'point_tickets'], ['eventBootstrap', 'event_tickets'], ['eventBootstrap', 'event_ticket_claims'], ['pointBootstrap', 'member_ticket_booking_options'], ['eventBootstrap', 'member_ticket_booking_options']]) {
  test(`${fn}: ${table} failure rejects instead of returning partial success`, async () => {
    await assert.rejects(api()[fn](database({ errorTable: table }), member), { code: 'DATABASE_ERROR' });
  });
}
test('unauthorized admin and disabled member cannot start optimized bootstrap queries', async () => {
  const context = api();
  const adminDb = database({ rows: { admins: [{ line_user_id: 'line-A', role: 'none', status: 'pending' }] } });
  await assert.rejects(context.handleAction(adminDb, identity, 'admin.bootstrap', {}), { code: 'ADMIN_PENDING' });
  assert.deepEqual(adminDb.calls.map(c => c.table), ['admins']);
  const memberDb = database({ rows: { members: [{ ...member, status: 'disabled' }] } });
  await assert.rejects(context.handleAction(memberDb, identity, 'user.pointcard.bootstrap', {}), { code: 'MEMBER_DISABLED' });
  // ensureMember also updates last_login_at before checking active membership.
  assert.ok(memberDb.calls.every(c => c.table === 'members'));
});

test('ticket eligibility options stay scoped to the authenticated member',async()=>{
  const db=database({rows:{bookingOptions:{points:{AVAILABLE:[{bookingId:'qa-booking'}]},event:{}}}});const result=await api().pointBootstrap(db,member);
  assert.equal(result.cardDetails.CARD.tickets[0].eligibleBookings[0].bookingId,'qa-booking');
  assert.equal(db.calls.find(c=>c.table==='member_ticket_booking_options').args.p_member_id,member.id);
});
for(const [action,refField,ref,kind]of [['user.pointcard.ticket.redeem','ticketId','AVAILABLE','points'],['user.event.ticket.redeem','claimId','OWNED','event']])test(action+' uses authenticated identity and selected booking, rejecting missing booking before mutation',async()=>{
  const context=api(),db=database({rows:{event_ticket_claims:[{member_id:member.id,event_ticket_id:event.id,claim_id:'OWNED',status:'claimed',event_tickets:event}]}});
  await assert.rejects(context.handleAction(db,identity,action,{[refField]:ref}),{code:'BOOKING_TICKET_CONFIRMATION_REQUIRED'});
  assert.equal(db.calls.some(c=>c.table==='redeem_member_tickets_for_booking_request'),false);
  const bookingId='10000000-0000-4000-8000-000000000001';
  await context.handleAction(db,identity,action,{[refField]:ref,bookingId,requestId:'QA-USE-123456',lineUserId:'forged-owner',memberId:'forged-member'});
  const args=db.calls.find(c=>c.table==='redeem_member_tickets_for_booking_request').args;
  assert.equal(args.p_line_user_id,identity.lineUserId);assert.equal(args.p_booking_id,bookingId);assert.equal(args.p_kind,kind);assert.equal(args.p_request_id,'QA-USE-123456');assert.deepEqual(Array.from(args.p_refs),[ref]);
});
