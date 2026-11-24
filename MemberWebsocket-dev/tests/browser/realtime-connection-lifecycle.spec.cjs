const { test, expect } = require('playwright/test');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { WebSocketServer } = require('../integration/node_modules/ws');
let server, websocketServer, base;
const sockets = new Set();
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (['/member.js', '/booking.js'].includes(req.url)) {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(fs.readFileSync(path.resolve(__dirname, req.url === '/member.js' ? '../../member-system.js' : '../../booking/common.js')));
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="UTF-8"><output id="updates">0</output>');
  });
  websocketServer = new WebSocketServer({ server });
  websocketServer.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await new Promise(resolve => websocketServer.close(resolve));
  await new Promise(resolve => server.close(resolve));
});

for (const kind of ['member', 'booking']) test(`REALTIME_LIFECYCLE ${kind}: real sockets close, recover once and coalesce event bursts`, async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-24T00:00:00Z') });
  await page.goto(base); await page.addScriptTag({ url: base + '/' + kind + '.js' });
  await page.clock.pauseAt(new Date('2026-11-24T00:01:00Z'));
  await page.evaluate(kind => {
    // The local provider stub uses real browser WebSockets. This tests the
    // transport lifecycle; it is not a live Supabase or LINE authentication test.
    window.received = 0; window.updated = 0; window.created = 0; window.opened = 0;
    window.supabase = { createClient: () => ({
      channel() {
        window.created++;
        return {
          on(_type, _filter, callback) { this.change = callback; return this; },
          subscribe(callback) {
            this.status = callback;
            this.socket = new WebSocket(location.origin.replace('http:', 'ws:'));
            this.socket.addEventListener('open', () => { window.opened++; callback('SUBSCRIBED'); });
            this.socket.addEventListener('message', event => { window.received++; this.change(JSON.parse(event.data)); });
            this.socket.addEventListener('close', () => callback('CLOSED'));
            return this;
          },
        };
      },
      removeChannel(channel) {
        return new Promise(resolve => { channel.socket.addEventListener('close', resolve, { once: true }); channel.socket.close(); });
      },
    }) };
    const cfg = { realtimeEnabled: true, supabaseUrl: 'https://fixture.supabase.co',
      supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api', supabasePublishableKey: 'synthetic-public', memberLiffId: 'member' };
    const update = () => { document.querySelector('#updates').textContent = String(++window.updated); };
    window.stopSync = kind === 'member' ? window.MemberSystem.subscribeRealtime(cfg, 'member', update) : window.BookingSystem.subscribeRealtime(cfg, update);
  }, kind);
  await expect.poll(() => sockets.size).toBe(1);
  await expect.poll(() => page.evaluate(() => window.opened)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => sockets.size).toBe(0);
  await page.clock.runFor(60000); await expect(page.locator('#updates')).toHaveText('0');
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('pageshow')); });
  await expect.poll(() => sockets.size).toBe(1);
  await expect.poll(() => page.evaluate(() => window.opened)).toBe(2);
  expect(await page.evaluate(() => window.created)).toBe(2);
  await page.clock.runFor(2000); await expect(page.locator('#updates')).toHaveText('1');
  for (const socket of sockets) for (let i = 0; i < 100; i++) socket.send(JSON.stringify({ new: { scope: 'member', event_type: 'booking.changed' } }));
  await expect.poll(() => page.evaluate(() => window.received)).toBe(100);
  await page.clock.runFor(2000); await expect(page.locator('#updates')).toHaveText('2');
  await page.evaluate(() => window.stopSync()); await expect.poll(() => sockets.size).toBe(0);
  await page.clock.runFor(60000); await expect(page.locator('#updates')).toHaveText('2');
});
