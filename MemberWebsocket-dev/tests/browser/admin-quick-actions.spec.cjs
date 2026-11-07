const { test, expect } = require('playwright/test');
const { startFixture } = require('./admin-fixture.cjs');
let host;
test.beforeAll(async () => { host = await startFixture(); });
test.afterAll(async () => { await host.close(); });

test('AC-UI-001: common shortcuts removed while existing admin tabs still work', async ({ page }, info) => {
  await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
  await expect(page.locator('#adminView')).toBeVisible();
  await expect(page.locator('#adminQuickActions')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '常用操作' })).toHaveCount(0);
  await page.locator('#cardsTab').click();
  await expect(page.locator('#cardsTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#cardsPanel')).toBeVisible();
  await page.locator('#membersTab').click();
  await expect(page.locator('#membersTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#membersPanel')).toBeVisible();
  expect(host.sessions.get(info.testId).unexpected).toEqual([]);
});

for (const width of [320, 390, 768, 1280]) {
  test('AC-UI-002: native navigation keyboard works at ' + width + 'px without shortcuts', async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
    await expect(page.locator('#adminView')).toBeVisible();
    await expect(page.locator('#adminQuickActions')).toHaveCount(0);
    const tab = page.locator('#calendarTab');
    await expect(tab).toBeVisible();
    await tab.focus();
    await expect(tab).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#calendarPanel')).toBeVisible();
    expect(host.sessions.get(info.testId).unexpected).toEqual([]);
  });
}
