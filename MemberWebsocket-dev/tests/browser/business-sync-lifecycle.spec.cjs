const { test, expect } = require('playwright/test');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (['/member.js', '/booking.js'].includes(req.url)) {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(fs.readFileSync(path.resolve(__dirname, req.url === '/booking.js' ? '../../booking/common.js' : '../../member-system.js')));
    }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="UTF-8"><output id="updates">0</output>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => new Promise(resolve => server.close(resolve)));

for (const kind of ['member', 'booking']) test(`SYNC_LIFECYCLE ${kind}: browser coalesces recovery and pauses pagehide`, async ({ page }) => {
  const probes = [], held = []; let hold = true;
  await page.clock.install({ time: new Date('2026-10-29T00:00:00Z') });
  await page.route('https://fixture.supabase.co/**', async route => {
    const body = route.request().postDataJSON();
    if (body.action.endsWith('.sync.status')) {
      probes.push(body);
      if (hold) { held.push(route); return; }
    }
    await route.fulfill({ json: { ok: true, data: { state: 'claimed', revision: '1' } } });
  });
  await page.goto(base); await page.addScriptTag({ url: base + '/' + kind + '.js' });
  await page.clock.pauseAt(new Date('2026-10-29T00:01:00Z'));
  await page.evaluate(async kind => {
    window.liff = { init: async () => {}, isLoggedIn: () => true, isInClient: () => true, getIDToken: () => 'synthetic-token' };
    const config = { business: 'shop-a', realtimeEnabled: true, supabaseUrl: 'https://fixture.supabase.co',
      supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api', supabasePublishableKey: 'fixture', memberLiffId: 'member', bookingLiffId: 'booking' };
    const update = () => { document.querySelector('#updates').textContent = String(++window.updateCount); };
    window.updateCount = 0;
    if (kind === 'booking') {
      await window.BookingSystem.completeSignIn(config, 'booking', 'synthetic-token');
      window.stopSync = window.BookingSystem.subscribeRealtime(config, update);
    } else {
      await window.MemberSystem.signIn(config, 'member');
      window.stopSync = window.MemberSystem.subscribeRealtime(config, 'member', update);
    }
  }, kind);
  await page.clock.runFor(1); await expect.poll(() => probes.length).toBe(1);
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  hold = false;
  await held.shift().fulfill({ json: { ok: true, data: { revision: '1' } } });
  await expect(page.locator('#updates')).toHaveText('1'); await page.clock.runFor(1);
  expect(probes).toHaveLength(1);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.clock.runFor(60000); expect(probes).toHaveLength(1);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await page.clock.runFor(1); await expect.poll(() => probes.length).toBe(2);
  await page.evaluate(() => window.stopSync());
  await page.clock.runFor(60000); expect(probes).toHaveLength(2);
});
