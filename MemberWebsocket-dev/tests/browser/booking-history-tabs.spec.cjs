const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
let server;
let baseUrl;

const fixtureScript = [
  "window.BookingSystem = { memberProfile: async () => ({}), request: async () => ({}) };",
  "window.MembershipProgress = { render() {} };",
  "window.renderFixtureHistory = function(statuses) {",
  "  const list = document.getElementById('bookingList');",
  "  list.replaceChildren(...statuses.map((status, index) => {",
  "    const card = document.createElement('article');",
  "    card.className = 'booking-item status-' + status;",
  "    card.dataset.bookingId = status + '-' + index;",
  "    if (new URLSearchParams(location.search).get('bookingId') === card.dataset.bookingId) card.classList.add('booking-detail-target');",
  "    const heading = document.createElement('div');",
  "    heading.className = 'booking-item-top';",
  "    heading.textContent = '預約 ' + status + ' ' + index;",
  "    const details = document.createElement('p');",
  "    details.textContent = '預約明細 ' + index;",
  "    card.append(heading, details);",
  "    return card;",
  "  }));",
  "  window.BookingMemberUI.organizeBookingHistory();",
  "};",
  "window.addEventListener('DOMContentLoaded', () => {",
  "  document.getElementById('bookingView').classList.remove('hidden');",
  "  document.getElementById('bookingDayModal').classList.remove('hidden');",
  "  window.renderFixtureHistory(['pending', 'confirmed', 'cancel_requested', 'completed', 'cancelled', 'rejected', 'no_show']);",
  "});",
].join('\n');

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/booking/') {
      const html = fs.readFileSync(path.join(root, 'booking/index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html.replace('</body>',
        '<script src="/booking-fixture.js" defer></script><script src="./member-ui.js" defer></script></body>'));
      return;
    }
    if (url.pathname === '/booking-fixture.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end(fixtureScript);
      return;
    }
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'application/javascript' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => new Promise((resolve) => server.close(resolve)));
test.beforeEach(async ({ page }) => {
  await page.route('https://**', (route) => route.abort());
});

for (const width of [320, 390, 1280]) {
  test('member booking tabs count, switch and retain selection at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 840 });
    await page.goto(baseUrl + '/booking/');
    const tabs = page.locator('#bookingList [role="tablist"]');
    await expect(tabs.getByRole('tab')).toHaveCount(4);
    for (const [key, count] of [['reserved', '3 筆'], ['completed', '1 筆'], ['cancelled', '2 筆'], ['no_show', '1 筆']]) {
      await expect(tabs.locator('[data-booking-tab="' + key + '"] .booking-history-tab-count')).toHaveText(count);
    }
    // Reorganizing existing grouped markup must not silently drop bookings.
    await page.evaluate(() => window.BookingMemberUI.organizeBookingHistory());
    await expect(tabs.getByRole('tab')).toHaveCount(4);
    await expect(page.locator('#bookingHistoryPanel-reserved .booking-item')).toHaveCount(3);
    await expect(page.locator('#bookingHistoryPanel-reserved')).toBeVisible();
    await expect(page.locator('#bookingHistoryPanel-no_show')).toBeHidden();
    await tabs.locator('[data-booking-tab="no_show"]').click();
    await expect(page.locator('#bookingHistoryPanel-no_show .booking-item')).toHaveCount(1);
    await expect(page.locator('#bookingHistoryPanel-no_show')).toBeVisible();
    await expect(page.locator('#bookingHistoryPanel-reserved')).toBeHidden();
    await expect(tabs.locator('[data-booking-tab="no_show"]')).toHaveAttribute('aria-selected', 'true');

    await page.evaluate(() => window.renderFixtureHistory(['confirmed', 'completed', 'completed', 'no_show']));
    await expect(tabs.locator('[data-booking-tab="reserved"] .booking-history-tab-count')).toHaveText('1 筆');
    await expect(tabs.locator('[data-booking-tab="completed"] .booking-history-tab-count')).toHaveText('2 筆');
    await expect(tabs.locator('[data-booking-tab="no_show"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#bookingHistoryPanel-no_show .booking-item')).toHaveCount(1);
    const bounds = await tabs.evaluate((element) => ({
      left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right,
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.viewport + 1);

    const noShow = tabs.locator('[data-booking-tab="no_show"]');
    await noShow.focus();
    await noShow.press('Home');
    await expect(tabs.locator('[data-booking-tab="reserved"]')).toHaveAttribute('aria-selected', 'true');
    await tabs.locator('[data-booking-tab="reserved"]').press('ArrowRight');
    await expect(tabs.locator('[data-booking-tab="completed"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#bookingHistoryPanel-completed .booking-item-top').first().click();
    await expect(page.locator('#bookingHistoryPanel-completed .booking-item').first()).toHaveClass(/is-expanded/);
  });
}

test('booking-specific links open the matching status tab', async ({ page }) => {
  await page.goto(baseUrl + '/booking/?bookingId=no_show-6');
  await expect(page.locator('[data-booking-tab="no_show"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#bookingHistoryPanel-no_show .booking-detail-target')).toHaveCount(1);
});


test('selected-scope runner executes every booking history tab and rejects a wrong badge', async ({page}) => {
  await page.goto(baseUrl + '/booking/');
  await expect(page.locator('#bookingHistoryTab-reserved')).toBeVisible();
  await page.evaluate(() => history.replaceState(null,'','/MemberWebsocket-dev/booking/'));
  await page.evaluate(fs.readFileSync(path.join(root,'user-test-control.js'),'utf8').replace(
    '  window.MemberUserTestControl =','  window.scopeProbe={bookingHistoryTabsCase};\n  window.MemberUserTestControl ='));
  expect((await page.evaluate(() => scopeProbe.bookingHistoryTabsCase())).status).toBe('passed');
  await page.locator('#bookingHistoryTab-completed .booking-history-tab-count').evaluate(node => node.textContent='99 筆');
  expect((await page.evaluate(() => scopeProbe.bookingHistoryTabsCase())).status).toBe('failed');
});
