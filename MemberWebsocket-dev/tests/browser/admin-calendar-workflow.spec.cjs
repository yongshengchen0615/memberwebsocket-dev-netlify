const { test, expect } = require('playwright/test');
const { startFixture } = require('./admin-fixture.cjs');

let host;
test.beforeAll(async () => { host = await startFixture(); });
test.afterAll(async () => { await host.close(); });
test.beforeEach(async ({ page }, info) => {
  // AC-014 exercises local admin calendars, not a remote map stylesheet.
  // The production HTML loads Leaflet CSS from a CDN; under isolated CI,
  // waiting for an unrelated external resource can exhaust the 20s load budget.
  // Keep the original full page-load and visible-workspace assertions intact.
  await page.route('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css', route =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '/* unrelated map stylesheet, isolated fixture */' })
  );
  await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
  await expect(page.locator('#adminView')).toBeVisible();
});

async function createOnDay(page, gridId, kind) {
  const workspace = page.locator({adminCalendarGrid:'#calendarPanel .admin-calendar',eventTicketCalendarGrid:'#eventTicketCalendarWorkspace',bookingOverviewCalendarGrid:'#bookingOverviewCalendarWorkspace'}[gridId]);
  await expect(workspace.locator('[data-calendar-day-view]')).toBeVisible();
  await workspace.locator('[data-calendar-add]').click();
  await workspace.locator('[data-calendar-create="' + kind + '"]').click();
}

test('AC-014: entire blank day tile opens its day view and scoped create menu in all three admin calendars', async ({ page }) => {
  await page.locator('#calendarTab').click();
  await expect(page.locator('#adminCalendarGrid')).toBeVisible();
  const memberDay = page.locator('#adminCalendarGrid .admin-calendar-day[data-admin-calendar-date]').first();
  const activityDate = await memberDay.getAttribute('data-admin-calendar-date');
  await memberDay.click({ position: { x: 16, y: 70 } });
  await createOnDay(page, 'adminCalendarGrid', 'activity');
  await expect(page.locator('#calendarEditorModal')).toBeVisible();
  await expect(page.locator('#calendarItemType')).toHaveValue('event');
  await expect(page.locator('#calendarItemStartsOn')).toHaveValue(activityDate);
  await expect(page.locator('#calendarItemVisibilityPolicy')).toBeVisible();
  await page.locator('#calendarEditorModal .editor-modal-close').click();

  await page.locator('#eventsTab').click();
  const ticketDay = page.locator('#eventTicketCalendarGrid .admin-calendar-day[data-ticket-calendar-date]').first();
  const ticketDate = await ticketDay.getAttribute('data-ticket-calendar-date');
  await ticketDay.click({ position: { x: 16, y: 70 } });
  await createOnDay(page, 'eventTicketCalendarGrid', 'ticket');
  await expect(page.locator('#eventTicketEditorModal')).toBeVisible();
  await expect(page.locator('#eventTicketStartsOn')).toHaveValue(ticketDate);
  await expect(page.locator('#eventTicketVisibilityPolicy')).toHaveValue('eligible_only');
  await page.locator('#eventTicketEditorModal .editor-modal-close').click();

  await page.locator('#bookingTab').click();
  const bookingDay = page.locator('#bookingOverviewCalendarGrid .admin-calendar-day[data-booking-calendar-date]').first();
  const holidayDate = await bookingDay.getAttribute('data-booking-calendar-date');
  await bookingDay.click({ position: { x: 16, y: 70 } });
  await createOnDay(page, 'bookingOverviewCalendarGrid', 'holiday');
  await expect(page.locator('#calendarEditorModal')).toBeVisible();
  await expect(page.locator('#calendarItemType')).toHaveValue('holiday');
  await expect(page.locator('#calendarItemStartsOn')).toHaveValue(holidayDate);
  await expect(page.locator('#calendarItemAllowedTiers')).toBeHidden();
});

test('AC-015: booking holiday saves and remains editable; it cannot leak into the activity calendar', async ({ page }, info) => {
  await page.locator('#bookingTab').click();
  await page.locator('#bookingOverviewCalendarGrid .admin-calendar-day[data-booking-calendar-date]').first().click({ position: { x: 16, y: 70 } });
  await createOnDay(page, 'bookingOverviewCalendarGrid', 'holiday');
  await page.locator('#calendarItemTitle').fill('QA 店休日');
  await page.locator('#calendarItemStatus').selectOption('draft');
  await page.locator('#saveCalendarItemButton').click();
  await expect.poll(() => host.sessions.get(info.testId).calendarItems.length).toBe(1);
  const stored = host.sessions.get(info.testId).calendarItems[0];
  expect(stored.itemType).toBe('holiday');
  await page.locator('#calendarEditorModal .editor-modal-close').click();
  const holidayEntry = page.locator('#bookingOverviewCalendarWorkspace [data-calendar-entry="' + stored.calendarItemId + '"]').first();
  await expect(holidayEntry).toBeVisible();
  await holidayEntry.click();
  await expect(page.locator('#calendarItemId')).toHaveValue(stored.calendarItemId);
  await expect(page.locator('#calendarItemType')).toHaveValue('holiday');
  await page.locator('#calendarEditorModal .editor-modal-close').click();
  await page.locator('#calendarTab').click();
  await expect(page.locator('#adminCalendarGrid [data-admin-calendar-item-id="' + stored.calendarItemId + '"]')).toHaveCount(0);
});

test('AC-016: independent member-event audience and visibility choices round-trip through the editor', async ({ page }, info) => {
  await page.locator('#calendarTab').click();
  await page.locator('#adminCalendarGrid .admin-calendar-day[data-admin-calendar-date]').first().click({ position: { x: 16, y: 70 } });
  await createOnDay(page, 'adminCalendarGrid', 'activity');
  await page.locator('#calendarItemTitle').fill('QA 白金專屬活動');
  await page.locator('#calendarItemStatus').selectOption('draft');
  for (const tier of ['general', 'silver', 'gold']) {
    await page.locator('#calendarItemAllowedTiers input[value="' + tier + '"]').uncheck();
  }
  await page.locator('#calendarItemVisibilityPolicy').selectOption('higher_preview');
  await page.locator('#saveCalendarItemButton').click();
  await expect.poll(() => host.sessions.get(info.testId).calendarItems.length).toBe(1);
  const row = host.sessions.get(info.testId).calendarItems[0];
  expect(row.allowedTierKeys).toEqual(['platinum']);
  expect(row.visibilityPolicy).toBe('higher_preview');
  await page.locator('#calendarEditorModal .editor-modal-close').click();
  await page.locator('#calendarPanel [data-calendar-entry="' + row.calendarItemId + '"]').first().click();
  await expect(page.locator('#calendarItemVisibilityPolicy')).toHaveValue('higher_preview');
  await expect(page.locator('#calendarItemAllowedTiers input[value="platinum"]')).toBeChecked();
});

test('AC-017: light and dark schemes color all calendar tiles with the shared design tokens', async ({ page }) => {
  for (const [tab, grid] of [['calendarTab', 'adminCalendarGrid'], ['eventsTab', 'eventTicketCalendarGrid'], ['bookingTab', 'bookingOverviewCalendarGrid']]) {
    await page.locator('#' + tab).click();
    await expect(page.locator('#' + grid)).toBeVisible();
    const tiles = page.locator('#' + grid + ' .admin-calendar-day:not(.admin-calendar-day-empty)');
    const values = [];
    for (const theme of ['light', 'dark']) {
      await page.evaluate((themeName) => window.LumenTheme.set(themeName), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const actual = await tiles.first().evaluate((node) => {
        const tile = getComputedStyle(node);
        return { background: tile.backgroundColor, foreground: tile.color, border: tile.borderTopColor };
      });
      values.push(actual);
      expect(actual.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(actual.foreground).not.toBe(actual.background);
    }
    expect(values[0].background).not.toBe(values[1].background);
    expect(values[0].foreground).not.toBe(values[1].foreground);
  }
});


test('AC-018: activity-ticket calendar checkbox can be enabled, saved, read back and disabled', async ({ page }, info) => {
  await page.locator('#eventsTab').click();
  await page.locator('#newEventTicketButton').click();
  await expect(page.locator('#eventTicketEditorModal')).toBeVisible();
  await page.locator('#eventTicketTitle').fill('QA 可切換日曆活動');
  await page.locator('#eventTicketDescription').fill('活動說明');
  await page.locator('#eventTicketUsageMethod').fill('櫃檯出示');
  await page.locator('#eventTicketUsageInstructions').fill('出示票券由櫃檯確認');
  await page.locator('#eventTicketStatus').selectOption('draft');
  await page.locator('#eventTicketStartsOn').fill('2026-12-20');
  await expect(page.locator('#eventTicketAddToCalendar')).toBeEnabled();
  await page.locator('#eventTicketAddToCalendar').check();
  await page.locator('#saveEventTicketButton').click();
  await expect.poll(() => host.sessions.get(info.testId).calendarItems.length).toBe(1);
  const linked = host.sessions.get(info.testId).calendarItems[0];
  const ticket = host.sessions.get(info.testId).eventTickets[0];
  expect(linked.itemType).toBe('event');
  expect(linked.startsOn).toBe('2026-12-20');
  expect(linked.visibilityPolicy).toBe('eligible_only');
  expect(new URL(linked.linkUrl).searchParams.get('eventTicketId')).toBe(ticket.eventTicketId);

  await page.locator('#eventTicketEditorModal .editor-modal-close').click();
  await page.locator('#eventTicketListItems [data-event-ticket-id="' + ticket.eventTicketId + '"]').click();
  await expect(page.locator('#eventTicketAddToCalendar')).toBeEnabled();
  await expect(page.locator('#eventTicketAddToCalendar')).toBeChecked();
  await page.locator('#eventTicketAddToCalendar').uncheck();
  await page.locator('#saveEventTicketButton').click();
  await expect.poll(() => host.sessions.get(info.testId).calendarItems.length).toBe(0);
  expect(host.sessions.get(info.testId).eventTickets).toHaveLength(1);
});
