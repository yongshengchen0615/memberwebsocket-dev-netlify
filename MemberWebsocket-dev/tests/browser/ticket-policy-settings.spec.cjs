const { test, expect } = require('playwright/test');
const { startFixture } = require('./admin-fixture.cjs');

let host;
test.beforeAll(async () => { host = await startFixture(); });
test.afterAll(async () => { await host.close(); });

async function openAdmin(page, testId) {
  await page.route('https://**', (route) => route.abort());
  await page.goto(host.base + '/admin/?run=' + encodeURIComponent(testId));
  await expect(page.locator('#adminView')).toBeVisible();
}

for (const width of [1280, 320]) {
  test('global ticket settings load, preview, validate and save at ' + width + 'px', async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await openAdmin(page, info.testId);

    await page.locator('#cardsTab').click();
    const point = page.locator('#pointCardGlobalTicketSettings');
    await expect(point).toBeVisible();
    await expect(point.locator('#globalTicketCurrentLimit')).toContainText('1 張／次');
    await expect(point.locator('#saveGlobalTicketSettingButton')).toBeDisabled();
    await point.locator('[data-policy-limit="0"]').click();
    await expect(point.locator('#globalTicketPreview')).toContainText('不限張數');
    await expect(point.locator('#saveGlobalTicketSettingButton')).toBeEnabled();
    await point.locator('#saveGlobalTicketSettingButton').click();
    await expect(point.locator('#globalTicketCurrentLimit')).toContainText('不限張數');
    await expect(point.locator('#saveGlobalTicketSettingButton')).toBeDisabled();
    await point.locator('#globalMaxTicketsPerRedemption').fill('51');
    await expect(point.locator('#globalTicketPreview')).toContainText('0–50');
    await expect(point.locator('#saveGlobalTicketSettingButton')).toBeDisabled();
    await point.locator('[data-policy-limit="3"]').click();
    await expect(point.locator('#saveGlobalTicketSettingButton')).toBeEnabled();
    await point.locator('#saveGlobalTicketSettingButton').click();
    await expect(point.locator('#globalTicketCurrentLimit')).toContainText('3 張／次');

    await page.locator('#eventsTab').click();
    const event = page.locator('#eventTicketGlobalUsageSettings');
    await expect(event).toBeVisible();
    await expect(event.locator('#eventTicketCurrentLimit')).toContainText('1 張／日');
    await event.locator('[data-policy-limit="0"]').click();
    await expect(event.locator('#eventTicketPreview')).toContainText('不限張數');
    await event.locator('#saveEventTicketSettingButton').click();
    await expect(event.locator('#eventTicketCurrentLimit')).toContainText('不限張數');
    await expect(event.locator('#saveEventTicketSettingButton')).toBeDisabled();

    const s = host.sessions.get(info.testId);
    expect(s.limits['pointcard-extension-api'].maxTicketsPerRedemption).toBe(3);
    expect(s.limits['event-ticket-extension-api'].maxTicketsPerDay).toBe(0);
    expect(s.unexpected).toEqual([]);
    expect(pageErrors).toEqual([]);

    for (const panel of [point, event]) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator(panel === point ? '#cardsTab' : '#eventsTab').click();
      await expect(panel).toBeVisible();
      const bounds = await panel.evaluate((el) => ({
        width: el.getBoundingClientRect().width,
        left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right,
        viewport: window.innerWidth,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth
      }));
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
      expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1);
    }
  });
}

test('tier preview updates only after saving and preserves server visibility policy', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page, info.testId);
  await page.locator('#eventsTab').click();
  const panel = page.locator('#ticketVisibilitySettings');
  await expect(panel).toBeVisible();
  const select = panel.locator('#ticketVisibilityPolicy');
  await expect(select).toHaveValue('eligible_only');
  await expect(panel.locator('#ticketVisibilityCurrent')).toContainText('只顯示符合資格');
  await expect(panel.locator('#saveTicketVisibility')).toBeDisabled();
  await select.selectOption('higher_preview');
  await expect(panel.locator('#ticketVisibilityPreview')).toContainText('鎖定狀態');
  await expect(panel.locator('#ticketVisibilityChangeStatus')).toContainText('尚未儲存');
  expect(host.sessions.get(info.testId).visibilityPolicy).toBe('eligible_only');
  await panel.locator('#saveTicketVisibility').click();
  await expect(panel.locator('#ticketVisibilityCurrent')).toContainText('較高階級鎖定預覽');
  await expect(panel.locator('#saveTicketVisibility')).toBeDisabled();
  expect(host.sessions.get(info.testId).visibilityPolicy).toBe('higher_preview');
  await panel.locator('#refreshTicketVisibility').click();
  await expect(select).toHaveValue('higher_preview');
  expect(host.sessions.get(info.testId).unexpected).toEqual([]);
});
