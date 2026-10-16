const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const base = path.join(__dirname, '..');
const config = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseFunctionUrl: 'https://example.supabase.co/functions/v1/api',
  supabasePublishableKey: 'test-public-key',
  memberLiffId: 'member', pointsLiffId: 'points', eventLiffId: 'event',
  adminLiffId: 'admin', calendarLiffId: 'calendar', bookingLiffId: 'booking',
  memberCalendarFunctionUrl: 'https://example.supabase.co/functions/v1/member-calendar-api',
};

function createWebViewHarness(relative) {
  const events = { window: new Map(), document: new Map() };
  const fetches = [];
  const beacons = [];
  let nextId = 1;
  const document = {
    visibilityState: 'visible',
    addEventListener(type, handler) { events.document.set(type, handler); },
  };
  const navigator = {
    sendBeacon(url, body) { beacons.push({ url, body }); return true; },
  };
  const window = {
    crypto: { randomUUID() { return '00000000-0000-4000-8000-' + String(nextId++).padStart(12, '0'); } },
    localStorage: { getItem() { return null; }, setItem() {} },
    liff: { isLoggedIn() { return true; }, getIDToken() { return 'test-line-id-token'; } },
    setTimeout() { return 1; },
    clearTimeout() {},
    addEventListener(type, handler) { events.window.set(type, handler); },
  };
  const fetch = async (url, options = {}) => {
    fetches.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: 200, data: {} }),
    };
  };
  const file = fs.readFileSync(path.join(base, relative), 'utf8');
  const close = file.lastIndexOf('})();');
  assert.ok(close !== -1, 'WebView script should be an IIFE');
  const instrumented = file.slice(0, close) +
    '\n  window.__presenceTest = { startPresence };\n' + file.slice(close);
  vm.runInNewContext(instrumented, {
    window, document, navigator, fetch, Blob, AbortController, console,
    URL, setTimeout, clearTimeout,
  }, { filename: relative });
  return { window, document, navigator, fetches, beacons, events };
}

for (const [surface, file] of [
  ['member', 'member-system.js'],
  ['booking', 'booking/common.js'],
]) {
  test(surface + ': hiding LINE WebView emits one offline beacon; returning uses a new session', async () => {
    const ctx = createWebViewHarness(file);
    await ctx.window.__presenceTest.startPresence(config, surface, 'test-line-id-token');
    assert.equal(ctx.fetches.length, 1, 'initial online request');
    const first = JSON.parse(ctx.fetches[0].options.body);
    assert.equal(first.action, 'user.' + surface + '.presence.online');
    ctx.document.visibilityState = 'hidden';
    ctx.events.document.get('visibilitychange')();
    ctx.events.window.get('pagehide')({ persisted: false });
    assert.equal(ctx.beacons.length, 1, 'hidden and pagehide must not double-report');
    const offline = JSON.parse(await ctx.beacons[0].body.text());
    assert.equal(offline.action, 'user.' + surface + '.presence.offline');
    assert.equal(offline.reason, 'hidden');
    assert.equal(offline.sessionId, first.sessionId);
    assert.equal(offline.idToken, 'test-line-id-token');
    assert.equal(ctx.beacons[0].url, config.supabaseFunctionUrl);
    assert.equal(ctx.beacons[0].body.type, 'text/plain;charset=utf-8');

    ctx.document.visibilityState = 'visible';
    ctx.events.document.get('visibilitychange')();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.fetches.length, 2, 'resumed page emits new online request');
    const second = JSON.parse(ctx.fetches[1].options.body);
    assert.equal(second.action, 'user.' + surface + '.presence.online');
    assert.equal(second.reason, 'resume');
    assert.notEqual(first.sessionId, second.sessionId, 'delayed old beacon must not affect resumed session');
  });

  test(surface + ': fetch keepalive is used when browser cannot queue beacon', async () => {
    const ctx = createWebViewHarness(file);
    await ctx.window.__presenceTest.startPresence(config, surface, 'test-line-id-token');
    ctx.navigator.sendBeacon = () => false;
    ctx.document.visibilityState = 'hidden';
    ctx.events.document.get('visibilitychange')();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.fetches.length, 2);
    const last = ctx.fetches[1];
    assert.equal(JSON.parse(last.options.body).reason, 'hidden');
    assert.equal(last.options.keepalive, true);
    assert.equal(last.options.headers['Content-Type'], 'text/plain;charset=UTF-8');
    assert.equal(last.options.headers.apikey, undefined, 'simple POST avoids CORS preflight');
  });
}
