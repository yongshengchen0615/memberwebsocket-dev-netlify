const { test, expect } = require('playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let server, base;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/business-context.js')) {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(fs.readFileSync(path.resolve(__dirname, '../../business-context.js')));
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>fixture</title><main id="bookingView"><span data-tenant-brand="預約">fixture</span><nav><a id="points" href="/points/">點數</a></nav><div id="changes"></div></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => new Promise(resolve => server.close(resolve)));

for (const width of [390, 1280]) test(`BUSINESS_CONTEXT_DOM ${width}: dynamic gates, merchant navigation and bounded mutation work`, async ({ page }) => {
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  let features = { membership: true, booking: true, events: true, points: false, calendar: true };
  await page.setViewportSize({ width, height: 900 });
  await page.route('https://fixture.supabase.co/**', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    await route.fulfill({ json: { ok: true, data: { business: body.business, name: '商家', features, line: { bookingLiffId: 'synthetic' } } } });
  });
  await page.goto(base + '/booking/?business=shop-a');
  await page.addScriptTag({ url: base + '/business-context.js' });
  await page.evaluate(async () => {
    window.config = { supabaseFunctionUrl: 'https://fixture.supabase.co/functions/v1/api', supabasePublishableKey: 'synthetic' };
    await window.BusinessContext.configure(window.config);
    window.documentQueries = 0;
    const query = document.querySelectorAll.bind(document);
    document.querySelectorAll = selector => { window.documentQueries++; return query(selector); };
    document.getElementById('changes').innerHTML = '<section data-member-requires="points"><button id="action">測試</button><a id="newLink" href="/points/">點數</a></section>';
  });
  await expect(page.locator('#newLink')).toHaveAttribute('data-member-allowed', 'false');
  expect(await page.locator('#action').evaluate(node => node.closest('[inert]') !== null)).toBe(true);
  await expect(page.locator('#newLink')).toHaveAttribute('href', base + '/points/?business=shop-a');
  expect(await page.evaluate(() => window.documentQueries)).toBe(0);
  features = { ...features, points: true };
  await page.evaluate(() => window.BusinessContext.refresh(window.config));
  await expect(page.locator('#newLink')).toHaveAttribute('data-member-allowed', 'true');
  expect(await page.locator('#action').evaluate(node => node.closest('[inert]') !== null)).toBe(false);
  await page.evaluate(() => {
    const guide = document.createElement('a'); guide.id = 'guide'; guide.href = '/booking/'; guide.textContent = '前往預約';
    document.getElementById('changes').append(guide);
  });
  await expect(page.locator('#guide')).toHaveAttribute('data-member-allowed', 'true');
  features = { ...features, booking: false };
  await page.evaluate(() => window.BusinessContext.refresh(window.config));
  await expect(page.locator('#guide')).toHaveAttribute('data-member-allowed', 'false');
  await page.evaluate(() => { const guide = document.getElementById('guide'); guide.removeAttribute('href'); guide.textContent = '目前未開放'; });
  features = { ...features, booking: true };
  await page.evaluate(() => window.BusinessContext.refresh(window.config));
  await page.evaluate(() => { const guide = document.getElementById('guide'); guide.href = '/booking/?source=event'; guide.textContent = '前往預約'; });
  await expect(page.locator('#guide')).toHaveAttribute('data-member-allowed', 'true');
  await expect(page.locator('#guide')).toHaveAttribute('href', base + '/booking/?source=event&business=shop-a');
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.id = 'otherDocument'; document.body.append(frame);
    const moved = document.createElement('a'); moved.id = 'moved'; moved.href = '/points/?business=shop-b';
    document.getElementById('changes').append(moved); frame.contentDocument.body.append(moved);
  });
  await expect(page.frameLocator('#otherDocument').locator('#moved')).toHaveAttribute('href', '/points/?business=shop-b');
  expect(await page.frameLocator('#otherDocument').locator('#moved').getAttribute('data-member-allowed')).toBeNull();
  await page.evaluate(() => window.BusinessContext.set('shop-b'));
  await expect(page.locator('#points')).toHaveAttribute('href', base + '/points/?business=shop-b');
  await expect(page.locator('#newLink')).toHaveAttribute('data-member-allowed', 'false');
  await page.evaluate(() => window.BusinessContext.configure({ ...window.config }));
  await expect(page.locator('#newLink')).toHaveAttribute('data-member-allowed', 'true');
  expect(requests.map(body => body.business)).toEqual(['shop-a', 'shop-a', 'shop-a', 'shop-a', 'shop-b']);
  expect(errors).toEqual([]);
});
