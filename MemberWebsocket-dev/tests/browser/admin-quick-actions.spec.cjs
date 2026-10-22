const { test, expect } = require('playwright/test');
const { startFixture } = require('./admin-fixture.cjs');
let host;
test.beforeAll(async () => { host = await startFixture(); });
test.afterAll(async () => { await host.close(); });

test('AC-ADM-UX-003: shortcuts use existing tabs, no parallel business flow', async ({ page }, info) => {
  await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
  await expect(page.locator('#adminView')).toBeVisible();
  await expect(page.locator('#adminQuickActions')).toBeVisible();
  await expect(page.locator('#adminQuickActions button:visible')).toHaveCount(4);
  await expect(page.locator('#adminQuickActions').getByRole('button', { name: '狀態' })).toHaveCount(0);
  await page.locator('[data-admin-quick-tab="cardsTab"]').click();
  await expect(page.locator('#cardsTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#cardsPanel')).toBeVisible();
  await page.locator('[data-admin-quick-tab="membersTab"]').click();
  await expect(page.locator('#membersTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#membersPanel')).toBeVisible();
  expect(host.sessions.get(info.testId).unexpected).toEqual([]);
});

test('AC-ADM-UX-003/007: shortcut location follows source tabs and a replaced nav item', async ({ page }, info) => {
  await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
  await expect(page.locator('#adminQuickActions')).toBeVisible();
  const memberShortcut = page.locator('[data-admin-quick-tab="membersTab"]');
  const eventShortcut = page.locator('[data-admin-quick-tab="eventsTab"]');
  await page.locator('#membersTab').click();
  await expect(memberShortcut).toHaveAttribute('aria-current', 'location');
  await expect(eventShortcut).not.toHaveAttribute('aria-current');
  await page.locator('#eventsTab').click();
  await expect(eventShortcut).toHaveAttribute('aria-current', 'location');
  await expect(memberShortcut).not.toHaveAttribute('aria-current');
  // Feature-nav refreshes may replace DOM nodes without a full page reload.
  await page.evaluate(() => {
    const original = document.getElementById('eventsTab');
    original.replaceWith(original.cloneNode(true));
  });
  await expect(eventShortcut).toBeVisible();
  await expect(eventShortcut).toHaveAttribute('aria-current', 'location');
  await page.evaluate(() => { document.getElementById('eventsTab').disabled = true; });
  await expect(eventShortcut).toBeHidden();
  await expect(eventShortcut).not.toHaveAttribute('aria-current');
  expect(host.sessions.get(info.testId).unexpected).toEqual([]);
});

test('AC-ADM-UX-001: shortcut disappears when its existing tab is revoked', async ({ page }, info) => {
  await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
  await expect(page.locator('#adminQuickActions')).toBeVisible();
  await page.evaluate(() => { document.getElementById('eventsTab').disabled = true; });
  await expect(page.locator('[data-admin-quick-tab="eventsTab"]')).toBeHidden();
  await page.evaluate(() => { document.getElementById('eventsTab').disabled = false; });
  await expect(page.locator('[data-admin-quick-tab="eventsTab"]')).toBeVisible();
  await page.evaluate(() => { document.getElementById('adminView').classList.add('hidden'); });
  await expect(page.locator('#adminQuickActions')).toBeHidden();
  expect(host.sessions.get(info.testId).unexpected).toEqual([]);
});

for (const width of [320, 390, 768, 1280]) {
  test('AC-ADM-UX-006/007: responsive and keyboard shortcuts at ' + width + 'px', async ({ page }, info) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
    await expect(page.locator('#adminQuickActions')).toBeVisible();
    const grid = page.locator('#adminQuickActions .admin-quick-grid');
    const bounds = await grid.evaluate(element => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, viewport: window.innerWidth };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(-1);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
    const button = page.locator('[data-admin-quick-tab="calendarTab"]');
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#calendarTab')).toHaveAttribute('aria-selected', 'true');
    expect(host.sessions.get(info.testId).unexpected).toEqual([]);
  });
}
