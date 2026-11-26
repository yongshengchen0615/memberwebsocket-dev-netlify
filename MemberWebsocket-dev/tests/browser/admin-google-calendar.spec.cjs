const { test, expect } = require('playwright/test');
const { startFixture } = require('./admin-fixture.cjs');
let host;
test.beforeAll(async () => { host = await startFixture(); });
test.afterAll(async () => { await host.close(); });
const calendars = [
  ['calendarTab', '#calendarPanel .admin-calendar', 'adminCalendarGrid', 'admin-calendar-date'],
  ['eventsTab', '#eventTicketCalendarWorkspace', 'eventTicketCalendarGrid', 'ticket-calendar-date'],
  ['bookingTab', '#bookingOverviewCalendarWorkspace', 'bookingOverviewCalendarGrid', 'booking-calendar-date']
];
async function open(page, info) {
  await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
  await expect(page.locator('#adminView')).toBeVisible();
}

test('Google AC-001/002: three calendars share desktop tools, mini dates and continuous adjacent month cells', async ({ page }, info) => {
  await page.setViewportSize({width:1440,height:1000});
  await open(page, info);
  for (const [tab, selector, gridId, attr] of calendars) {
    await page.locator('#' + tab).click();
    const workspace = page.locator(selector);
    await workspace.locator('[data-calendar-month-picker]').fill('2027-01');
    await expect(workspace.locator('[data-calendar-mini]')).toBeVisible();
    await expect(workspace.locator('[data-calendar-view-select]')).toHaveValue('month');
    const grid = page.locator('#' + gridId);
    await expect(grid.locator('.admin-calendar-day')).toHaveCount(42);
    await expect(grid.locator('button[data-' + attr + ']')).toHaveCount(42);
    await expect(grid.locator('.is-outside-month').first()).toHaveAttribute('data-' + attr, '2026-12-27');
    await grid.locator('button[data-' + attr + '="2026-12-31"]').click();
    await expect(workspace.locator('[data-calendar-date-picker]')).toHaveValue('2026-12-31');
    await expect(workspace.locator('[data-calendar-view-select]')).toHaveValue('day');
    await workspace.locator('[data-calendar-view-select]').selectOption('month');
    await expect(grid).toBeVisible();
    await workspace.locator('[data-calendar-mini-date="2026-12-30"]').click();
    await expect(workspace.locator('[data-calendar-date-picker]')).toHaveValue('2026-12-30');
  }
  expect(host.sessions.get(info.testId).calls.filter(call => /\.save$|\.create$/.test(call.action))).toHaveLength(0);
});

test('Google AC-003/005: overflow button opens every booking, retains overnight entries and clears on revoke', async ({ page }, info) => {
  await open(page, info);
  await page.locator('#bookingTab').click();
  const rows = [1,2,3,4,5].map(n => ({bookingId:'overflow-' + n,bookingDate:'2027-01-01',startTime:'09:00',endTime:'10:00',memberDisplayName:'示意會員 ' + n,status:'confirmed'}));
  rows.push({bookingId:'overnight',bookingDate:'2026-12-31',startTime:'23:30',endTime:'01:10',memberDisplayName:'跨日會員',status:'confirmed'});
  await page.evaluate(bookings => window.dispatchEvent(new CustomEvent('member-admin:booking-snapshot',{detail:{bookings}})), rows);
  const workspace = page.locator('#bookingOverviewCalendarWorkspace');
  await workspace.locator('[data-calendar-month-picker]').fill('2027-01');
  const date = workspace.locator('.admin-calendar-day[data-booking-calendar-date="2027-01-01"]');
  await expect(date.locator('.admin-calendar-booking')).toHaveCount(3);
  await date.getByRole('button', {name:/另有 2 筆/}).click();
  await expect(workspace.locator('[data-calendar-day-view] [data-calendar-entry]')).toHaveCount(6);
  await expect(workspace.locator('[data-calendar-entry="overnight"]')).toContainText('前日');
  await page.evaluate(() => window.BusinessWorkspace.apply({features:{calendar:true,booking:false},business:{slug:'fixture',name:'QA'}}));
  await expect(workspace.locator('[data-calendar-entry]')).toHaveCount(0);
  await workspace.locator('[data-calendar-view-select]').selectOption('month');
  await expect(workspace.locator('.admin-calendar-booking')).toHaveCount(0);
  await expect(workspace.locator('.calendar-scope-more')).toHaveCount(0);
});

test('Google AC-003: activity and ticket overflow retains every original editor and safe full title', async ({ page }, info) => {
  await open(page, info);
  const session = host.sessions.get(info.testId);
  const title = '會員專屬活動 <img src=x onerror=alert(1)> ';
  session.calendarItems = [1,2,3,4,5].map(n => ({calendarItemId:'activity-'+n,title:title+n,itemType:'event',status:'draft',startsOn:'2027-01-01',endsOn:'2027-01-01',accent:'#6378c5'}));
  session.eventTickets = [1,2,3,4,5].map(n => ({eventTicketId:'ticket-'+n,title:'票券 '+n,ticketKind:'coupon',status:'draft',startsOn:'2027-01-01',endsOn:'2027-01-01',accent:'#6378c5'}));
  await page.reload();
  await expect(page.locator('#adminView')).toBeVisible();
  for (const [tab, selector, , attr] of calendars.slice(0,2)) {
    await page.locator('#'+tab).click();
    const workspace = page.locator(selector);
    await workspace.locator('[data-calendar-month-picker]').fill('2027-01');
    const date = workspace.locator('.admin-calendar-day[data-'+attr+'="2027-01-01"]');
    await expect(date.locator('.admin-calendar-item')).toHaveCount(3);
    await date.getByRole('button', {name:/另有 2 筆/}).click();
    await expect(workspace.locator('[data-calendar-day-view] [data-calendar-entry]')).toHaveCount(5);
    const ticket = tab === 'eventsTab';
    await workspace.locator('[data-calendar-entry="'+(ticket?'ticket-5':'activity-5')+'"]').click();
    await expect(page.locator(ticket?'#eventTicketTitle':'#calendarItemTitle')).toHaveValue(ticket?'票券 5':title+5);
    await expect(workspace.locator('img')).toHaveCount(0);
    await page.locator(ticket?'#eventTicketEditorModal .editor-modal-close':'#calendarEditorModal .editor-modal-close').click();
  }
  expect(session.calls.filter(call => /\.save$|\.create$/.test(call.action))).toHaveLength(0);
});

test('Google AC-002/004: today keeps its contrasting text when displayed in the adjacent month', async ({ page }, info) => {
  await page.clock.setFixedTime(new Date('2026-11-30T04:00:00Z'));
  await open(page, info);
  await page.locator('#calendarTab').click();
  const workspace = page.locator('#calendarPanel .admin-calendar');
  for (const theme of ['light','dark']) {
    await page.evaluate(value => window.LumenTheme.set(value), theme);
    await workspace.locator('[data-calendar-month-picker]').fill('2026-11');
    const colors = () => page.locator('#adminCalendarGrid .is-today .admin-calendar-day-number').evaluate(node => ({fg:getComputedStyle(node).color,bg:getComputedStyle(node).backgroundColor}));
    const current = await colors();
    await workspace.locator('[data-calendar-month-picker]').fill('2026-12');
    await expect(page.locator('#adminCalendarGrid .is-today')).toHaveClass(/is-outside-month/);
    expect(await colors()).toEqual(current);
  }
});

test('Google AC-001/005: snapshot refresh retains keyboard focus on the selected mini date', async ({ page }, info) => {
  await page.setViewportSize({width:1440,height:1000});
  await open(page, info);
  await page.locator('#bookingTab').click();
  const workspace = page.locator('#bookingOverviewCalendarWorkspace');
  await workspace.locator('[data-calendar-month-picker]').fill('2026-12');
  const date = workspace.locator('[data-calendar-mini-date="2026-12-20"]');
  await date.focus();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('member-admin:booking-snapshot',{detail:{bookings:[]}})));
  await expect(date).toBeFocused();
});

for (const width of [320,390,1440]) {
  for (const theme of ['light','dark']) {
    test(`Google AC-004: ${width}px ${theme} has seven columns, readable dates and tappable view controls`, async ({ page }, info) => {
      await page.setViewportSize({width,height:1000});
      await open(page, info);
      await page.evaluate(value => window.LumenTheme.set(value), theme);
      for (const [tab, selector, gridId] of calendars) {
        await page.locator('#' + tab).click();
        const workspace = page.locator(selector);
        await workspace.locator('[data-calendar-month-picker]').fill('2027-01');
        const viewSelect = workspace.locator('[data-calendar-view-select]');
        await viewSelect.scrollIntoViewIfNeeded();
        const viewIsClickable = await viewSelect.evaluate(select => {
          const rect = select.getBoundingClientRect();
          return select.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        });
        expect(viewIsClickable, 'The view selector can be tapped without an overlapping create button').toBe(true);
        const dimensions = await workspace.evaluate(node => {
          const grid = node.querySelector('.admin-calendar-grid');
          const digits = [...grid.querySelectorAll('.admin-calendar-day-number')];
          return {
            columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,
            overflow:document.documentElement.scrollWidth > innerWidth,
            clipped:digits.filter(digit => {
              const range = document.createRange(); range.selectNodeContents(digit);
              const text = range.getBoundingClientRect(), cell = digit.closest('.admin-calendar-day').getBoundingClientRect();
              return text.left < cell.left || text.right > cell.right;
            }).map(digit => digit.textContent),
            color:getComputedStyle(grid).color, background:getComputedStyle(grid).backgroundColor
          };
        });
        expect(dimensions.columns).toBe(7);
        expect(dimensions.overflow).toBe(false);
        expect(dimensions.clipped).toEqual([]);
        expect(dimensions.color).not.toBe(dimensions.background);
        await expect(workspace.locator('[data-calendar-mini]')).toBeVisible({visible:width >= 1200});
        await workspace.locator('[data-calendar-view-select]').selectOption('day');
        await expect(workspace.locator('[data-calendar-day-view]')).toBeVisible();
        await workspace.locator('[data-calendar-view-select]').selectOption('month');
        await expect(page.locator('#' + gridId)).toBeVisible();
      }
    });
  }
}
