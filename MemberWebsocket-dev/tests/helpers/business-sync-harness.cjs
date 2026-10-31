const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };

async function businessSyncHarness(kind, source) {
  let now = 10000, id = 0, revision = 'initial', holdProbes = false, holdUpdates = false;
  const timers = new Map(), listeners = new Map(), storage = new Map();
  const probes = [], updates = [], benefits = [], heldUpdates = [];
  function events(prefix) {
    return {
      addEventListener(type, fn) {
        const key = prefix + type;
        if (!listeners.has(key)) listeners.set(key, new Set());
        listeners.get(key).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(prefix + type)?.delete(fn); },
    };
  }
  const document = { ...events('d:'), visibilityState: 'visible', querySelector: () => null, querySelectorAll: () => [] };
  const navigator = { onLine: true };
  const window = {
    ...events('w:'), crypto: webcrypto,
    location: { pathname: '/booking/', href: 'https://fixture.test/booking/' },
    setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    setInterval: () => ++id, clearInterval() {},
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    liff: { init: async () => {}, isLoggedIn: () => true, isInClient: () => true, getIDToken: () => 'synthetic-identity' },
  };
  const config = {
    business: 'shop-a', realtimeEnabled: true,
    supabaseUrl: 'https://fixture.supabase.co', supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api',
    supabasePublishableKey: 'fixture-public', memberLiffId: 'member', bookingLiffId: 'booking', adminLiffId: 'admin',
  };
  const response = data => ({ status: 200, ok: true,
    json: async () => ({ ok: true, data }), text: async () => JSON.stringify({ ok: true, data }) });
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (!body.action.endsWith('.sync.status')) return response({ state: 'claimed' });
    const entry = { body, url, revision };
    probes.push(entry);
    if (!holdProbes) return response({ revision });
    return new Promise(resolve => { entry.resolve = () => resolve(response({ revision: entry.revision })); });
  };
  const filename = kind === 'booking' ? 'booking/common.js' : 'member-system.js';
  vm.runInNewContext(source || fs.readFileSync(path.join(__dirname, '../..', filename), 'utf8'), {
    window, document, navigator, fetch, URL, URLSearchParams, AbortController, console,
    Date: class extends Date { static now() { return now; } },
  });
  const system = kind === 'booking' ? window.BookingSystem : window.MemberSystem;
  if (kind === 'booking') await system.completeSignIn(config, 'booking', 'synthetic-identity');
  else await system.signIn(config, 'member');
  const update = () => {
    updates.push(revision);
    if (holdUpdates) return new Promise(resolve => heldUpdates.push(resolve));
  };
  const subscribe = (cfg = config, onUpdate = update) => kind === 'booking'
    ? system.subscribeRealtime(cfg, onUpdate, 'member', () => { benefits.push(revision); })
    : system.subscribeRealtime(cfg, 'member', onUpdate);
  return {
    window, document, navigator, config, probes, updates, benefits, subscribe,
    setRevision(value) { revision = value; },
    holdProbes(value = true) { holdProbes = value; },
    holdUpdates(value = true) { holdUpdates = value; },
    finishUpdate() { heldUpdates.shift()?.(); },
    emit(type, documentEvent = false) {
      for (const fn of listeners.get((documentEvent ? 'd:' : 'w:') + type) || []) fn({ type });
    },
    get listenerCount() { return [...listeners.values()].reduce((sum, fns) => sum + fns.size, 0); },
    async tick(ms = 0) {
      await flush();
      const end = now + ms;
      for (let i = 0; i < 500; i++) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
module.exports = { businessSyncHarness, flush };
