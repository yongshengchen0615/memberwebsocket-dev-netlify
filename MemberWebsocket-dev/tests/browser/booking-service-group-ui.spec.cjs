const { test, expect } = require('playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
let server, base;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/member-benefits.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(fs.readFileSync(path.join(root, 'booking/booking-benefits.js')));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><section id="bookingBenefits"><p id="bookingBenefitsStatus" tabindex="-1"></p><button id="bookingBenefitsRetry" class="hidden">重試</button><div id="bookingBenefitsList"></div></section><script src="/member-benefits.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => new Promise(resolve => server.close(resolve)));

for (const width of [390, 1280]) {
  test('AC-SERVICE-GROUP-UI-003 Chromium ' + width + ': A+B or A+C restriction visible and live eligibility changes without reload', async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(base + '/');
    await page.evaluate(() => {
      const groups = [['A', 'B'], ['A', 'C']];
      const label = 'A 項目＋B 項目 或 A 項目＋C 項目，符合其中一組即可';
      window.MemberUI = {
        pointCardStyleKey: () => 'lagoon',
        pointTicketDetails: () => document.createElement('div'),
      };
      window.BookingSystem = {
        bookingBenefits: async () => ({
          eventTicketMaxPerDay: 2, pointTicketMaxPerRedemption: 2,
          items: [
            { kind: 'points', id: 'reward', selectionId: 'PT-1', selectable: true,
              title: '集點券', cardId: 'CARD', cardTitle: '集點卡',
              pointCost: 5, pointBalance: 10, requiredServiceIds: [],
              requiredServiceGroups: groups, requiredServiceRequirementLabel: label,
              conditionLabel: '預約項目限制：' + label },
            { kind: 'event', id: 'event', selectionId: 'EC-1', selectable: true,
              title: '活動券', requiredServiceIds: [], requiredServiceGroups: groups,
              requiredServiceRequirementLabel: label, conditionLabel: '預約項目限制：' + label },
          ],
        }),
      };
      window.BookingBenefits.start({}, 'test-token');
    });
    const list = page.locator('#bookingBenefitsList');
    await expect(list.locator('.booking-benefit')).toHaveCount(2);
    await expect(list.locator('.booking-benefit-group-status')).toHaveCount(2);
    await expect(list).toContainText('A 項目＋B 項目 或 A 項目＋C 項目');
    await expect(list.locator('.booking-benefit-group-status[data-group-requirement-met="false"]')).toHaveCount(2);
    await expect(list.locator('input[type="checkbox"]:disabled')).toHaveCount(2);
    await page.evaluate(() => BookingBenefits.setServiceContext(['B', 'C']));
    await expect(list.locator('input[type="checkbox"]:disabled')).toHaveCount(2);
    await page.evaluate(() => BookingBenefits.setServiceContext(['A', 'B']));
    await expect(list.locator('.booking-benefit-group-status[data-group-requirement-met="true"]')).toHaveCount(2);
    await expect(list.locator('input[type="checkbox"]:enabled')).toHaveCount(2);
    await list.locator('input[data-booking-benefit-id="PT-1"]').check();
    await page.evaluate(() => BookingBenefits.setServiceContext(['A', 'C']));
    expect(await page.evaluate(() => BookingBenefits.selectionPayload())).toEqual([{ kind: 'points', id: 'PT-1' }]);
    await page.evaluate(() => BookingBenefits.setServiceContext(['A']));
    await expect(list.locator('input[type="checkbox"]:disabled')).toHaveCount(2);
    expect(await page.evaluate(() => BookingBenefits.selectionPayload())).toEqual([]);
  });
}
