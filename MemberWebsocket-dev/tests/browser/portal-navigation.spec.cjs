'use strict';
const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
const script = fs.readFileSync(path.join(root, 'portal-navigation.js'), 'utf8');
const actualPage = file => fs.readFileSync(path.join(root, file), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const cases = [
  { name: 'member nested shell', html: actualPage('member/index.html'), surface: 'member', before: 'app' },
  { name: 'admin workspace', html: actualPage('admin/workspace.html'), surface: 'admin' },
  { name: 'direct main after another child', html: '<html data-portal-surface="member"><body><div id="first"></div><main id="content"></main></body></html>', surface: 'member', before: 'content' },
  { name: 'empty body', html: '<html data-portal-surface="admin"><body></body></html>', surface: 'admin' },
  { name: 'platform excluded', html: actualPage('platform/index.html'), surface: 'platform' },
];
let server, origin;
test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/portal-navigation.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      return response.end('window.navigationInitialReadyState = document.readyState;\n' + script);
    }
    const match = /^\/fixture\/(\d+)$/.exec(url.pathname);
    const fixture = match && cases[Number(match[1])];
    if (!fixture) { response.writeHead(404); return response.end(); }
    const html = url.searchParams.get('timing') === 'loading'
      ? fixture.html.replace('</body>', '<script src="/portal-navigation.js"></script></body>')
      : fixture.html;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

for (const width of [390, 1280]) for (const timing of ['loading', 'ready']) for (const fixture of cases) {
  test(`AC-136 ${fixture.name} ${width}px ${timing}: valid insertion, role isolation and one mount`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 });
    // Keep the real DOM and CSP. Only the fixture and same-origin navigation load.
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin && (url.pathname.startsWith('/fixture/') || url.pathname === '/portal-navigation.js')
        ? route.continue() : route.abort();
    });
    await page.goto(`${origin}/fixture/${cases.indexOf(fixture)}?timing=${timing}`);
    if (timing === 'ready') await page.addScriptTag({ url: origin + '/portal-navigation.js' });
    expect(await page.evaluate(() => window.navigationInitialReadyState)).toBe(timing === 'loading' ? 'loading' : 'complete');
    const nav = page.locator('#unifiedPortalNav');
    if (fixture.surface !== 'admin') {
      await expect(nav).toHaveCount(0);
      if (fixture.surface === 'member') {
        await expect(page.locator('[data-portal-entry="member"]')).toHaveCount(0);
      }
    } else {
      await expect(nav).toHaveCount(1);
      expect(await nav.evaluate(node => node.parentElement.tagName)).toBe('BODY');
      if (fixture.before) expect(await nav.evaluate(node => node.nextElementSibling.id)).toBe(fixture.before);
      await expect(nav.locator('a')).toHaveCount(1);
      await expect(nav.locator('a')).toHaveAttribute('href', `/${fixture.surface}/`);
      await expect(nav.locator('a')).toHaveAttribute('aria-current', 'page');
      await page.addScriptTag({ url: origin + '/portal-navigation.js' });
      await expect(nav).toHaveCount(1);
    }
    expect(errors).toEqual([]);
  });
}
