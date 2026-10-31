const { test, expect } = require('playwright/test');
const { startFixture } = require('./admin-fixture.cjs');

let host;
test.beforeAll(async () => { host = await startFixture(); });
test.afterAll(async () => { await host.close(); });

test('AC-008: group selections survive an empty service-catalog refresh and persist across save/reload', async ({ page }, info) => {
  await page.route('https://**', route => route.abort());
  await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
  await expect(page.locator('#adminView')).toBeVisible();
  await page.locator('#eventsTab').click();
  await page.locator('#newEventTicketButton').click();

  await page.locator('#eventTicketTitle').fill('組合回歸票券');
  await page.locator('#eventTicketDescription').fill('測試預約服務組合');
  await page.locator('#eventTicketUsageMethod').fill('預約使用');
  await page.locator('#eventTicketUsageInstructions').fill('符合任一組合才能使用');
  await page.locator('#eventTicketStatus').selectOption('active');
  await page.locator('#eventTicketRequiredServiceMatchMode').selectOption('groups');

  const groups = page.locator('#eventTicketRequiredServiceGroups');
  const first = groups.locator('[data-service-combination]').first();
  await first.locator('input[value="service-1"]').check();
  await first.locator('input[value="service-2"]').check();
  await groups.locator('.ticket-service-group-add').click();
  const second = groups.locator('[data-service-combination]').nth(1);
  await second.locator('input[value="service-1"]').check();

  const services = structuredClone(host.sessions.get(info.testId).services);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('member-admin:booking-services-updated', {
    detail: { services: [] }
  })));
  await expect(groups.locator('input[type="checkbox"]')).toHaveCount(0);
  await page.evaluate(items => window.dispatchEvent(new CustomEvent('member-admin:booking-services-updated', {
    detail: { services: items }
  })), services);

  await expect(groups.locator('[data-service-combination]')).toHaveCount(2);
  await expect(first.locator('input[value="service-1"]')).toBeChecked();
  await expect(first.locator('input[value="service-2"]')).toBeChecked();
  await expect(second.locator('input[value="service-1"]')).toBeChecked();
  await page.locator('#saveEventTicketButton').click();

  await expect.poll(() => host.sessions.get(info.testId).eventTickets.length).toBe(1);
  const saved = host.sessions.get(info.testId).eventTickets[0];
  expect(saved.requiredServiceMatchMode).toBe('groups');
  expect(saved.requiredServiceGroups).toEqual([['service-1', 'service-2'], ['service-1']]);

  await page.reload();
  await expect(page.locator('#adminView')).toBeVisible();
  await page.locator('#eventsTab').click();
  await page.locator('[data-event-ticket-id="' + saved.eventTicketId + '"]').first().click();
  await expect(page.locator('#eventTicketRequiredServiceMatchMode')).toHaveValue('groups');
  const restored = page.locator('#eventTicketRequiredServiceGroups [data-service-combination]');
  await expect(restored).toHaveCount(2);
  await expect(restored.nth(0).locator('input[value="service-1"]')).toBeChecked();
  await expect(restored.nth(0).locator('input[value="service-2"]')).toBeChecked();
  await expect(restored.nth(1).locator('input[value="service-1"]')).toBeChecked();
  expect(host.sessions.get(info.testId).unexpected).toEqual([]);
});

test('AC-009: a legacy API that drops groups cannot report a successful save or replace the draft with any', async ({ page }, info) => {
  await page.route('https://**', route => route.abort());
  await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
  await expect(page.locator('#adminView')).toBeVisible();
  const session = host.sessions.get(info.testId);
  session.legacyTicketApiDropsGroups = true;
  await page.locator('#eventsTab').click();
  await page.locator('#newEventTicketButton').click();
  await page.locator('#eventTicketTitle').fill('避免組合悄悄遺失');
  await page.locator('#eventTicketDescription').fill('後端舊版模擬');
  await page.locator('#eventTicketUsageMethod').fill('預約使用');
  await page.locator('#eventTicketUsageInstructions').fill('需 A+B');
  await page.locator('#eventTicketStatus').selectOption('active');
  await page.locator('#eventTicketRequiredServiceMatchMode').selectOption('groups');
  const items = page.locator('#eventTicketRequiredServiceGroups [data-service-combination]').first();
  await items.locator('input[value="service-1"]').check();
  await items.locator('input[value="service-2"]').check();
  await page.locator('#saveEventTicketButton').click();

  const alert = page.locator('#eventTicketFormMessage');
  await expect(alert).toContainText('後端未保留預約組合設定');
  await expect(alert).not.toHaveClass(/success/);
  await expect(page.locator('#eventTicketRequiredServiceMatchMode')).toHaveValue('groups');
  await expect(items.locator('input[value="service-1"]')).toBeChecked();
  await expect(items.locator('input[value="service-2"]')).toBeChecked();
  expect(session.eventTickets).toHaveLength(1);
  expect(session.eventTickets[0].requiredServiceMatchMode).toBe('any');
  const writes = session.calls.filter(call => call.action === 'admin.event-tickets.save');
  expect(writes).toHaveLength(1);
  expect(writes[0].payload.eventTicket.requiredServiceMatchMode).toBe('groups');
  expect(writes[0].payload.eventTicket.requiredServiceGroups).toEqual([['service-1','service-2']]);
  expect(session.unexpected).toEqual([]);
});
