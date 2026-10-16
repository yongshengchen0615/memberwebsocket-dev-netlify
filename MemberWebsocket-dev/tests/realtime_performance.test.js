const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type) { for (const fn of listeners.get(type) || []) fn(); },
    count() { return [...listeners.values()].reduce((n, items) => n + items.size, 0); },
  };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(surface, { enabled = true } = {}) {
  let now = 0, timerId = 0, onChange, onStatus, removed = 0;
  const timers = new Map();
  const channel = { on(_, __, callback) { onChange = callback; return this; }, subscribe(callback) { onStatus = callback; return this; } };
  const window = { ...events(), supabase: { createClient() { return { channel() { return channel; }, removeChannel() { removed++; } }; } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const document = { ...events(), visibilityState: 'visible', querySelector() { return {}; } };
  const navigator = { onLine: true };
  const context = vm.createContext({ window, document, navigator, URL, console, Date: class extends Date { static now() { return now; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../member-system.js'), 'utf8'), context);
  const config = { realtimeEnabled: enabled, supabaseUrl: 'https://example.supabase.co', supabaseFunctionUrl: 'https://example.supabase.co/functions/v1/api', memberCalendarFunctionUrl: 'https://example.supabase.co/functions/v1/member-calendar-api', supabasePublishableKey: 'fixture', memberLiffId: 'member', pointsLiffId: 'points', eventLiffId: 'event', calendarLiffId: 'calendar', adminLiffId: 'admin' };
  return { window, document, navigator, timers,
    subscribe(fn) { return window.MemberSystem.subscribeRealtime(config, surface, fn); },
    change(scope = surface) { onChange({ new: { scope } }); },
    status(value) { onStatus(value); },
    removed() { return removed; },
    async tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}

for (const surface of ['member', 'points', 'event', 'calendar', 'admin']) {
  test(`${surface}: 100 events during a slow refresh produce one trailing refresh and no overlap`, async () => {
    const h = harness(surface); let calls = 0, active = 0, peak = 0, finish;
    const stop = h.subscribe(() => { calls++; active++; peak = Math.max(peak, active); return new Promise(resolve => { finish = () => { active--; resolve(); }; }); });
    h.change('unrelated'); await h.tick(2000); assert.equal(calls, 0);
    h.change(); await h.tick(650); assert.equal(calls, 1);
    for (let i = 0; i < 100; i++) { h.change(i % 2 ? surface : 'all'); await h.tick(20); }
    assert.equal(calls, 1); assert.equal(h.timers.size, 0);
    finish(); await flush(); await h.tick(0);
    assert.equal(calls, 2); assert.equal(peak, 1);
    finish(); await flush(); await h.tick(3000); assert.equal(calls, 2); stop();
  });
  test(`${surface}: realtime and page-resume signals coalesce, pause in background and recover online`, async () => {
    const h = harness(surface); let calls = 0;
    const stop = h.subscribe(() => { calls++; });
    h.document.visibilityState = 'hidden'; h.change(); h.window.emit('pageshow');
    await h.tick(5000); assert.equal(calls, 0);
    h.document.visibilityState = 'visible'; h.document.emit('visibilitychange'); h.window.emit('online'); h.change();
    await h.tick(0); assert.equal(calls, 1);
    h.navigator.onLine = false; h.change(); await h.tick(3000); assert.equal(calls, 1);
    h.navigator.onLine = true; h.window.emit('online'); await h.tick(0); assert.equal(calls, 2);
    stop(); assert.equal(h.window.count() + h.document.count(), 0);
  });
  test(`${surface}: initial subscribe is quiet, reconnect refreshes, duplicate subscribe adds no listeners`, async () => {
    const h = harness(surface); let calls = 0;
    const stop = h.subscribe(() => { calls++; });
    assert.equal(h.subscribe(() => assert.fail('duplicate callback')), stop);
    assert.equal(h.window.count() + h.document.count(), 3);
    h.status('SUBSCRIBED'); await h.tick(2000); assert.equal(calls, 0);
    h.status('CHANNEL_ERROR'); h.status('SUBSCRIBED'); await h.tick(0); assert.equal(calls, 1);
    h.change(); stop(); stop(); await h.tick(3000); assert.equal(calls, 1);
    assert.equal(h.removed(), 1); assert.equal(h.window.count() + h.document.count(), 0);
  });
  test(`${surface}: synchronous throw and rejected refresh do not wedge the queue`, async () => {
    const h = harness(surface); let calls = 0;
    const stop = h.subscribe(() => { calls++; if (calls === 1) throw new Error('fixture'); if (calls === 2) return Promise.reject(new Error('fixture')); });
    for (let i = 0; i < 3; i++) { h.change(); await h.tick(2000); }
    assert.equal(calls, 3); stop();
  });
  test(`${surface}: unsubscribe during a request cancels trailing work and disabled realtime installs nothing`, async () => {
    const h = harness(surface); let finish, calls = 0;
    const stop = h.subscribe(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
    h.change(); await h.tick(650); h.change(); stop(); finish(); await flush(); await h.tick(5000);
    assert.equal(calls, 1); assert.equal(h.timers.size, 0);
    const disabled = harness(surface, { enabled: false }); disabled.subscribe(() => assert.fail('disabled refresh'))();
    assert.equal(disabled.window.count() + disabled.document.count(), 0);
  });
}
