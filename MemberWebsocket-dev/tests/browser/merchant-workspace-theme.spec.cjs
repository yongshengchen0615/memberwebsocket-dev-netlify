const { test, expect } = require('playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
let server;
let base;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end();
    }
    res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function openMerchantTheme(page) {
  // The appearance control operates before login. Isolate external auth to test
  // the real HTML, shared controller, stylesheet and browser without real accounts.
  for (const script of [
    '**/platform/app.js*', '**/platform/expiry-term.js*',
    '**/member-system.js*', '**/business-context.js*',
    '**/portal-navigation.js*', '**/admin/business-line-settings.js*'
  ]) await page.route(script, (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route('https://static.line-scdn.net/**', (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto(base + '/admin/workspace.html');
  await expect(page.locator('#themeToggleButton')).toBeVisible();
  await page.evaluate(() => {
    document.getElementById('myMerchantsWorkspace').hidden = false;
    document.getElementById('merchantWorkspace').hidden = false;
  });
}

test('AC-004: merchant theme toggles actual card and form colors, persists, syncs tabs, and works on mobile', async ({ context }) => {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'light' });
  await openMerchantTheme(page);
  const toggle = page.locator('#themeToggleButton');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const surface = page.locator('#merchantTitleForm');
  const lightBackground = await surface.evaluate((node) => getComputedStyle(node).backgroundColor);

  const secondPage = await context.newPage();
  await openMerchantTheme(secondPage);
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(secondPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-label', '切換為亮色調');
  const darkBackground = await surface.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(darkBackground).not.toBe(lightBackground);
  expect(await page.evaluate(() => localStorage.getItem('lumen-color-theme-v1'))).toBe('dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator('#themeToggleButton').boundingBox();
  expect(bounds).toBeTruthy();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
  await page.locator('#themeToggleButton').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(secondPage.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.close();
  await secondPage.close();
});
