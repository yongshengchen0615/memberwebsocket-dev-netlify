const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

// Breaks caught: speculative click reads, dropped completion signals, stale
// identity responses and a request that permanently locks the refresh owner.
function harness() {
  const listeners = new Map(), calls = [], timers = new Map();
  const nodes = new Map([['eventSummary', { parentElement: { append(node) { nodes.set(node.id, node); } } }]]);
  const events = target => ({ addEventListener(type, fn) { const key = target + type; if (!listeners.has(key)) listeners.set(key, []); listeners.get(key).push(fn); } });
  let session = { config: { supabaseUrl: 'https://fixture.supabase.co', supabasePublishableKey: 'public', business: 'shop-a' }, idToken: 'member-a' };
  const window = { ...events('w:'), MemberSystem: { getSession: () => session },
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  const document = { ...events('d:'), visibilityState: 'visible', getElementById: id => nodes.get(id),
    createElement: () => ({ dataset: {}, classList: { add() {}, remove() {} } }) };
  const fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    calls.push({ url, options, resolve: count => resolve({ ok: true, json: async () => ({ ok: true, data: { usedTodayCount: count, maxTicketsPerDay: 5 } }) }), reject });
  });
  vm.runInNewContext(fs.readFileSync(require.resolve('../event/today-usable.js'), 'utf8'), { window, document, fetch, AbortController });
  return { calls, timers, nodes, setSession(value) { session = value; }, getSession: () => session,
    emit(type, detail, target = 'w:') { for (const fn of listeners.get(target + type) || []) fn({ detail, target: { closest: () => true } }); },
    async flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); } };
}

test('AC-001: clicking before a slow mutation finishes never speculates with a delayed request', async () => {
  const h = harness(); h.emit('click', null, 'd:');
  for (const fn of h.timers.values()) fn();
  await h.flush(); assert.equal(h.calls.length, 0);
  h.emit('event-ticket:redeemed'); assert.equal(h.calls.length, 1);
  h.calls[0].resolve(1); await h.flush();
  assert.match(h.nodes.get('todayUsableTicketCount').textContent, /今日已使用 1 張/);
});

test('AC-002: a completion during an older read queues exactly one fresh trailing read', async () => {
  const h = harness(); h.emit('focus');
  for (let i = 0; i < 100; i++) h.emit('event-ticket:redeemed');
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(0); await h.flush(); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(1); await h.flush(); assert.equal(h.calls.length, 2);
  assert.match(h.nodes.get('todayUsableTicketCount').textContent, /今日已使用 1 張/);
  assert.equal(h.timers.size, 0);
});

test('AC-002: a failed read releases the owner and preserves a queued completion', async () => {
  const h = harness(); h.emit('focus'); h.emit('event-ticket:redeemed');
  h.calls[0].reject(new Error('offline')); await h.flush();
  assert.equal(h.calls.length, 2); h.calls[1].resolve(2); await h.flush();
  assert.match(h.nodes.get('todayUsableTicketCount').textContent, /今日已使用 2 張/);
});

test('AC-002: an old member or business response cannot update the current badge', async () => {
  const h = harness(); h.emit('focus');
  h.setSession({ config: { ...h.getSession().config, business: 'shop-b' }, idToken: 'member-b' });
  h.emit('user-tour:ready', { surface: 'event' });
  h.calls[0].resolve(9); await h.flush(); assert.equal(h.nodes.has('todayUsableTicketCount'), false);
  h.calls[1].resolve(1); await h.flush();
  assert.match(h.nodes.get('todayUsableTicketCount').textContent, /今日已使用 1 張/);
});

test('AC-002: logout discards late errors and does not issue another authenticated read', async () => {
  const h = harness(); h.emit('focus'); h.setSession(null); h.emit('event-ticket:redeemed');
  h.calls[0].reject(new Error('late error')); await h.flush();
  assert.equal(h.nodes.has('todayUsableTicketCount'), false); assert.equal(h.calls.length, 1);
});

test('AC-002: a bounded request deadline releases the owner without retrying', async () => {
  const h = harness(); h.emit('focus');
  assert.equal(h.timers.size, 1);
  [...h.timers.values()][0](); await h.flush();
  assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 1);
  h.emit('event-ticket:changed'); assert.equal(h.calls.length, 2);
  h.calls[1].resolve(0); await h.flush();
});
