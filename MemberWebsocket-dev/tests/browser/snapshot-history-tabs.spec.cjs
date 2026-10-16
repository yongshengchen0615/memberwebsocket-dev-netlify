const { test, expect } = require('playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
let server;
let baseUrl;
const fixtureScript = [
  "window.BookingSystem = { getSession: () => ({config: {}, idToken:'fixture'}), request: async () => ({}) };",
  "window.BookingReceipts = { refresh:async()=>{}, endSnapshotMode() {}, beginSnapshotMode:async()=>{} };",
  "window.BookingBenefits = { getItems:()=>[], syncNow(){} };",
  "window.__snapshotRows = [",
  "  {receiptId:'pending-1',status:'awaiting_review',createdAt:'2026-10-12T02:00:00Z',requestedBenefits:[{title:'集點卡 A'}]},",
  "  {receiptId:'pending-2',status:'awaiting_review',createdAt:'2026-10-12T03:00:00Z'},",
  "  {receiptId:'registered-1',status:'bound',createdAt:'2026-10-12T04:00:00Z',settlement:{service_minutes:45}},",
  "  {receiptId:'attention-1',status:'failed',dismissed:true,createdAt:'2026-10-12T05:00:00Z'},",
  "  {receiptId:'attention-2',status:'failed',createdAt:'2026-10-12T06:00:00Z'},",
  "  {receiptId:'withdrawn-1',status:'failed',cancelled:true,createdAt:'2026-10-12T07:00:00Z'},",
  "];",
  "window.__renderSnapshotRows = rows => window.dispatchEvent(new CustomEvent('booking:receipts-updated', {detail:{submissions: rows}}));",
  "window.addEventListener('DOMContentLoaded', () => {",
  "  document.getElementById('bookingView').classList.remove('hidden');",
  "  window.__renderSnapshotRows(window.__snapshotRows);",
  "});",
].join('\n');

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/booking/') {
      const html = fs.readFileSync(path.join(root, 'booking/index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html.replace('</body>', '<script src="/snapshot-fixture.js" defer></script><script src="./booking-accessible.js" defer></script></body>'));
      return;
    }
    if (url.pathname === '/snapshot-fixture.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end(fixtureScript);
      return;
    }
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'application/javascript' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => new Promise(resolve => server.close(resolve)));
test.beforeEach(async ({ page }) => {
  await page.route('https://**', route => route.abort());
});

for (const width of [320, 390, 1280]) {
  test('counted snapshot history switches categories at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 840 });
    await page.goto(baseUrl + '/booking/');
    const root = page.locator('#bookingSnapshotHistory');
    const tabs = root.getByRole('tablist', { name: '快照預約明細分類' });
    await expect(tabs.getByRole('tab')).toHaveCount(4);
    for (const [key, count] of [['pending', '2 筆'], ['registered', '1 筆'], ['attention', '2 筆'], ['withdrawn', '1 筆']]) {
      await expect(tabs.locator('[data-snapshot-history-tab="' + key + '"] .booking-history-tab-count')).toHaveText(count);
    }
    await expect(root.locator('#snapshotHistoryPanel-pending')).toBeVisible();
    await expect(root.locator('#snapshotHistoryPanel-attention')).toBeHidden();
    await tabs.locator('[data-snapshot-history-tab="attention"]').click();
    await expect(root.locator('#snapshotHistoryPanel-attention details')).toHaveCount(2);
    await expect(root.locator('#snapshotHistoryPanel-attention')).toBeVisible();
    await expect(root.locator('#snapshotHistoryPanel-pending')).toBeHidden();
    await expect(root.locator('#snapshotHistoryPanel-attention details').first().locator('summary')).toHaveText(/需重新提供收據/);
    await expect(root.locator('#snapshotHistoryPanel-attention details').nth(1).locator('summary')).toHaveText(/處理未完成/);
    await page.evaluate(() => window.__renderSnapshotRows([
      {receiptId:'pending-1',status:'awaiting_review',createdAt:'2026-10-12T02:00:00Z'},
      {receiptId:'registered-2',status:'bound',settlement:{service_minutes:90}},
      {receiptId:'attention-1',status:'failed',dismissed:true},
    ]));
    await expect(tabs.locator('[data-snapshot-history-tab="attention"]')).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.locator('[data-snapshot-history-tab="attention"] .booking-history-tab-count')).toHaveText('1 筆');
    await expect(tabs.locator('[data-snapshot-history-tab="withdrawn"] .booking-history-tab-count')).toHaveText('0 筆');
    await expect(root.locator('#snapshotHistoryPanel-attention details')).toHaveCount(1);
    await root.locator('#snapshotHistoryPanel-attention summary').click();
    await expect(root.locator('#snapshotHistoryPanel-attention details')).toHaveAttribute('open', '');

    await tabs.locator('[data-snapshot-history-tab="attention"]').focus();
    await tabs.locator('[data-snapshot-history-tab="attention"]').press('Home');
    await expect(tabs.locator('[data-snapshot-history-tab="pending"]')).toHaveAttribute('aria-selected', 'true');
    await tabs.locator('[data-snapshot-history-tab="pending"]').press('ArrowRight');
    await expect(tabs.locator('[data-snapshot-history-tab="registered"]')).toHaveAttribute('aria-selected', 'true');
    const geometry = await tabs.evaluate(node => ({right:node.getBoundingClientRect().right,left:node.getBoundingClientRect().left,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport + 1);
  });
}

test('snapshot receipt deep link opens its classification and expands the requested details', async ({ page }) => {
  await page.goto(baseUrl + '/booking/?receiptId=withdrawn-1');
  const root = page.locator('#bookingSnapshotHistory');
  await expect(root.locator('[data-snapshot-history-tab="withdrawn"]')).toHaveAttribute('aria-selected', 'true');
  await expect(root.locator('#snapshotHistoryPanel-withdrawn .booking-detail-target')).toHaveAttribute('open', '');
});

test('switching member identity clears previous snapshot history', async ({ page }) => {
  await page.goto(baseUrl + '/booking/');
  const root = page.locator('#bookingSnapshotHistory');
  await expect(root).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('booking:member-loaded', {detail:{profile:{lineUserId:'new-member'}}})));
  await expect(root).toBeHidden();
  await page.evaluate(() => window.__renderSnapshotRows([{receiptId:'new-only',status:'bound'}]));
  await expect(root.locator('details')).toHaveCount(1);
  await expect(root.locator('details').first()).toHaveAttribute('data-receipt-id', 'new-only');
});

test('empty status panels show zero and do not duplicate removed snapshots', async ({ page }) => {
  await page.goto(baseUrl + '/booking/');
  await page.evaluate(() => window.__renderSnapshotRows([{receiptId:'one',status:'bound'}]));
  const root = page.locator('#bookingSnapshotHistory');
  await expect(root.locator('[data-snapshot-history-tab="pending"] .booking-history-tab-count')).toHaveText('0 筆');
  await expect(root.locator('[data-snapshot-history-tab="registered"]')).toHaveAttribute('aria-selected', 'true');
  await root.locator('[data-snapshot-history-tab="withdrawn"]').click();
  await expect(root.locator('#snapshotHistoryPanel-withdrawn .snapshot-history-empty')).toBeVisible();
  await page.evaluate(() => window.__renderSnapshotRows([]));
  await expect(root).toBeHidden();
});

test('receipt refresh preserves expanded details and keyboard focus without stealing outside focus', async ({ page }) => {
  await page.goto(baseUrl + '/booking/');
  const root = page.locator('#bookingSnapshotHistory');
  const tab = root.locator('#snapshotHistoryTab-pending');
  const row = root.locator('[data-receipt-id="pending-1"]');
  await row.locator('summary').click();
  await tab.focus();
  await page.evaluate(() => window.__renderSnapshotRows(window.__snapshotRows));
  await expect(row).toHaveAttribute('open', '');
  await expect(tab).toBeFocused();
  await row.locator('summary').focus();
  await page.evaluate(() => window.__renderSnapshotRows(window.__snapshotRows.map(receipt =>
    receipt.receiptId === 'pending-1' ? {...receipt, requestedBenefits:[{title:'更新後票券'}]} : receipt)));
  await expect(row.locator('summary')).toBeFocused();
  await expect(row).toContainText('更新後票券');
  await page.locator('#bookingAccessibleToggle').focus();
  await page.evaluate(() => window.__renderSnapshotRows(window.__snapshotRows));
  await expect(page.locator('#bookingAccessibleToggle')).toBeFocused();
});

test('a receipt deep link respects manual collapse after subsequent updates', async ({ page }) => {
  await page.goto(baseUrl + '/booking/?receiptId=withdrawn-1');
  const row = page.locator('#bookingSnapshotHistory [data-receipt-id="withdrawn-1"]');
  await expect(row).toHaveAttribute('open', '');
  await row.locator('summary').click();
  await page.evaluate(() => window.__renderSnapshotRows(window.__snapshotRows));
  await expect(row).not.toHaveAttribute('open', '');
});


test('selected-scope runner executes every snapshot history tab and rejects a wrong badge', async ({page}) => {
  await page.goto(baseUrl + '/booking/');
  await expect(page.locator('#snapshotHistoryTab-pending')).toBeVisible();
  await page.evaluate(() => history.replaceState(null,'','/MemberWebsocket-dev/booking/'));
  await page.evaluate(fs.readFileSync(path.join(root,'user-test-control.js'),'utf8').replace(
    '  window.MemberUserTestControl =','  window.scopeProbe={bookingSnapshotHistoryTabsCase};\n  window.MemberUserTestControl ='));
  expect((await page.evaluate(() => scopeProbe.bookingSnapshotHistoryTabsCase())).status).toBe('passed');
  await page.locator('#snapshotHistoryTab-registered .booking-history-tab-count').evaluate(node => node.textContent='99 筆');
  expect((await page.evaluate(() => scopeProbe.bookingSnapshotHistoryTabsCase())).status).toBe('failed');
});
