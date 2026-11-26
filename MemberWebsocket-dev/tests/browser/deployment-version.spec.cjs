const { test, expect } = require('playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const output = path.join(projectRoot, 'dist');
const surfaces = ['', 'admin', 'member', 'points', 'event', 'calendar', 'booking'];
const publicConfigTag = /<script id="memberwebsocket-public-config" type="application\/json">[^<]*<\/script>/;
let server;
let base;

test.beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-site.mjs'], { cwd: projectRoot });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    let file = path.resolve(output, '.' + pathname);
    if (file === output || (fs.existsSync(file) && fs.statSync(file).isDirectory())) {
      file = path.join(file, 'index.html');
    }
    if (!file.startsWith(output + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
      : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.json') ? 'application/json; charset=utf-8'
        : 'application/octet-stream';
    let body = fs.readFileSync(file);
    if (file.endsWith('.html')) {
      const startup = url.searchParams.get('startup-fixture');
      const html = body.toString('utf8');
      if (startup === 'missing') body = Buffer.from(html.replace(publicConfigTag, ''));
      else if (startup === 'invalid') body = Buffer.from(html.replace(publicConfigTag,
        '<script id="memberwebsocket-public-config" type="application/json">{"supabaseUrl":null}</script>'));
      else if (startup === 'malformed') body = Buffer.from(html.replace(publicConfigTag,
        '<script id="memberwebsocket-public-config" type="application/json">{</script>'));
      else if (!startup) {
        // Keep the version badge tests focused on the deployed CSS and CSP.
        body = Buffer.from(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
      }
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

for (const width of [320, 390, 1280]) {
  test(`published site version stays visible on ${width}px screens, including mobile`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 760 });
    const seen = new Set();
    for (const surface of surfaces) {
      await page.goto(`${base}/${surface ? surface + '/' : ''}`, { waitUntil: 'load' });
      const badge = page.locator('#site-build-version');
      await expect(badge, `${surface || 'home'} should have exactly one badge`).toHaveCount(1);
      await expect(badge).toBeVisible();
      const displayed = await badge.textContent();
      expect(displayed).toMatch(/^v\d{6}\.\d{6}-[a-z0-9]{6}$/);
      seen.add(displayed);
      const geometry = await badge.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          position: style.position, zIndex: style.zIndex, opacity: Number(style.opacity),
          pointerEvents: style.pointerEvents, width: rect.width, height: rect.height,
        };
      });
      expect(geometry.position).toBe('fixed');
      expect(Number(geometry.zIndex)).toBeGreaterThan(1000);
      expect(geometry.pointerEvents).toBe('none');
      expect(geometry.opacity).toBeGreaterThan(0.5);
      expect(geometry.width).toBeGreaterThan(20);
      expect(geometry.height).toBeGreaterThan(8);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(760);
      expect(await badge.evaluate(node => node.hasAttribute('style'))).toBe(false);
      if (width === 390 && ['admin', 'member', 'booking'].includes(surface)) {
        const image = await page.screenshot({ animations: 'disabled' });
        await info.attach(`version-${surface}-mobile`, { body: image, contentType: 'image/png' });
      }
    }
    expect(seen.size).toBe(1);
  });
}

const business = 'startup-fixture';
const identities = { memberLiffId: '2012345678-fixtureMember', bookingLiffId: '2012345678-fixtureBooking' };

async function prepareStartup(page, { deny = false } = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(output, 'config/config.json'), 'utf8'));
  const settings = [];
  const publicRequests = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base) {
      if (url.pathname.endsWith('/config.json')) settings.push(url.pathname);
      return route.continue();
    }
    if (url.hostname === 'static.line-scdn.net' && url.pathname.endsWith('/sdk.js')) {
      return route.fulfill({ contentType: 'text/javascript', body: 'window.liff={init({liffId}){window.startedLiffId=liffId;return new Promise(()=>{});}};' });
    }
    if (url.origin === config.supabaseUrl && url.pathname === '/functions/v1/platform-api') {
      const headers = { 'Access-Control-Allow-Origin': base };
      if (request.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, apikey' } });
      }
      publicRequests.push(request.postDataJSON());
      if (deny) return route.fulfill({ status: 403, headers, json: { ok: false, error: { code: 'BUSINESS_BLOCKED', message: '測試商家權限遭拒' } } });
      return route.fulfill({ headers, json: { ok: true, data: { business, name: '測試商家', features: { membership: true, booking: true }, line: identities } } });
    }
    return route.abort();
  });
  return { config, settings, publicRequests };
}

for (const [surface, feature, fallbackPath] of [
  ['member', 'membership', '/config/config.json'],
  ['booking', 'booking', '/config.json'],
]) {
  test(`${surface} starts merchant LIFF using the embedded public deployment configuration`, async ({ page }) => {
    const { config, settings, publicRequests } = await prepareStartup(page);
    await page.goto(`${base}/${surface}/?business=${business}&startup-fixture=embedded`);
    await expect.poll(() => page.evaluate(() => window.startedLiffId)).toBe(identities[surface + 'LiffId']);
    expect(settings).toEqual([]);
    expect(publicRequests).toEqual([{ action: 'platform.business.public', business, feature }]);
    const freshConfig = await page.evaluate(() => {
      const first = window.BusinessContext.readEmbeddedConfig();
      first.supabaseUrl = 'changed';
      return window.BusinessContext.readEmbeddedConfig();
    });
    expect(freshConfig).toEqual(config);
  });

  test(`${surface} recovers when embedded public configuration is missing or invalid`, async ({ page }) => {
    const { settings, publicRequests } = await prepareStartup(page);
    for (const variant of ['missing', 'invalid', 'malformed']) {
      await page.goto(`${base}/${surface}/?business=${business}&startup-fixture=${variant}`);
      await expect.poll(() => page.evaluate(() => window.startedLiffId)).toBe(identities[surface + 'LiffId']);
    }
    expect(settings).toEqual(Array(3).fill(fallbackPath));
    expect(publicRequests).toEqual(Array(3).fill({ action: 'platform.business.public', business, feature }));
  });
}

test('embedded configuration still requires an allowed merchant before starting LIFF', async ({ page }) => {
  const { settings, publicRequests } = await prepareStartup(page, { deny: true });
  await page.goto(`${base}/member/?business=${business}&startup-fixture=embedded`);
  await expect(page.locator('#errorMessage')).toHaveText('測試商家權限遭拒');
  expect(await page.evaluate(() => window.startedLiffId)).toBeUndefined();
  expect(settings).toEqual([]);
  expect(publicRequests).toEqual([{ action: 'platform.business.public', business, feature: 'membership' }]);
});
