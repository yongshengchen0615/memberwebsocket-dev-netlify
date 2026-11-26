const { test, expect } = require('playwright/test');
const { startFixture } = require('./admin-fixture.cjs');
let host;
test.beforeAll(async () => { host = await startFixture(); });
test.afterAll(async () => { await host.close(); });

async function open(page, info, tab='calendarTab') {
  await page.goto(host.base + '/admin/?run=' + encodeURIComponent(info.testId));
  await expect(page.locator('#adminView')).toBeVisible();
  await page.locator('#' + tab).click();
}

test('AC-001/002: month picker crosses the year; day navigation returns to the selected month', async ({ page }, info) => {
  await open(page, info);
  const workspace = page.locator('#calendarPanel .admin-calendar');
  await workspace.locator('[data-calendar-month-picker]').fill('2026-12');
  await expect(page.locator('#adminCalendarMonthTitle')).toContainText('2026年12月');
  await workspace.locator('[data-calendar-month="2027-01-01"]').click();
  await expect(page.locator('#adminCalendarMonthTitle')).toContainText('2027年1月');
  await page.locator('#adminCalendarGrid button[data-admin-calendar-date="2027-01-01"]').click();
  await expect(workspace.locator('[data-calendar-day-view]')).toBeVisible();
  await expect(page.locator('#calendarEditorModal')).toBeHidden();
  await expect(workspace.locator('[data-calendar-date-picker]')).toHaveValue('2027-01-01');
  await workspace.locator('[data-calendar-previous-day]').click();
  await expect(workspace.locator('[data-calendar-date-picker]')).toHaveValue('2026-12-31');
  await workspace.locator('[data-calendar-month-view]').click();
  await expect(page.locator('#adminCalendarMonthTitle')).toContainText('2026年12月');
  await expect(page.locator('#adminCalendarGrid')).toBeVisible();
  await page.locator('#adminCalendarTodayButton').click();
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Taipei'}).format(new Date()));
  await workspace.locator('[data-calendar-open-day]').click();
  await expect(workspace.locator('[data-calendar-date-picker]')).toHaveValue(today);
  await workspace.locator('[data-calendar-date-picker]').fill('2027-01-02');
  await workspace.locator('[data-calendar-today]').click();
  await expect(workspace.locator('[data-calendar-date-picker]')).toHaveValue(today);
  expect(host.sessions.get(info.testId).calls.filter(call => /\.save$|\.create$/.test(call.action))).toHaveLength(0);
});

test('AC-003/004: all three ＋ menus preserve scope and chosen date; cancelling performs no write', async ({ page }, info) => {
  await open(page, info);
  for (const [tab, grid, attr, action, modal, input, type] of [
    ['calendarTab','adminCalendarGrid','admin-calendar-date','activity','calendarEditorModal','calendarItemStartsOn','event'],
    ['eventsTab','eventTicketCalendarGrid','ticket-calendar-date','ticket','eventTicketEditorModal','eventTicketStartsOn',null],
    ['bookingTab','bookingOverviewCalendarGrid','booking-calendar-date','holiday','calendarEditorModal','calendarItemStartsOn','holiday']
  ]) {
    await page.locator('#' + tab).click();
    const gridNode=page.locator('#'+grid);
    const workspace=gridNode.locator('..');
    const dateNode=gridNode.locator('button[data-'+attr+']').first();
    const date=await dateNode.getAttribute('data-'+attr);
    await dateNode.click();
    await workspace.locator('[data-calendar-add]').click();
    await expect(workspace.locator('[data-calendar-create]')).toHaveCount(1);
    await workspace.locator('[data-calendar-create="'+action+'"]').click();
    await expect(page.locator('#'+modal)).toBeVisible();
    await expect(page.locator('#'+input)).toHaveValue(date);
    if(type) await expect(page.locator('#calendarItemType')).toHaveValue(type);
    await page.locator('#'+modal+' .editor-modal-close').click();
    await expect(workspace.locator('[data-calendar-day-view]')).toBeVisible();
    await workspace.locator('[data-calendar-month-view]').click();
  }
  expect(host.sessions.get(info.testId).calls.filter(call => /\.save$|\.create$/.test(call.action))).toHaveLength(0);
});

test('AC-002/004: day timeline keeps overlapping, more-than-three and overnight bookings visible', async ({ page }, info) => {
  await open(page, info, 'bookingTab');
  const rows = [
    {bookingId:'night',bookingDate:'2026-12-31',startTime:'23:30',endTime:'01:10',memberDisplayName:'跨夜會員',status:'confirmed'},
    ...[1,2,3,4].map(n=>({bookingId:'day-'+n,bookingDate:'2027-01-01',startTime:'09:00',endTime:'10:00',memberDisplayName:'同時預約 '+n,status:'confirmed'})),
    {bookingId:'cancelled',bookingDate:'2027-01-01',startTime:'12:00',endTime:'13:00',memberDisplayName:'已取消不列出',status:'cancelled'}
  ];
  await page.evaluate(bookings => window.dispatchEvent(new CustomEvent('member-admin:booking-snapshot',{detail:{bookings}})),rows);
  const workspace=page.locator('#bookingOverviewCalendarWorkspace');
  await workspace.locator('[data-calendar-month-picker]').fill('2027-01');
  await page.locator('#bookingOverviewCalendarGrid button[data-booking-calendar-date="2027-01-01"]').click();
  await expect(workspace.locator('[data-calendar-day-view] [data-calendar-entry]')).toHaveCount(5);
  await expect(workspace.locator('[data-calendar-entry="night"]')).toContainText('前日');
  await expect(workspace.locator('[data-calendar-entry="night"]')).toContainText('01:10');
  await expect(workspace.locator('[data-calendar-day-view]')).not.toContainText('已取消不列出');
  await page.evaluate(bookings => window.dispatchEvent(new CustomEvent('member-admin:booking-snapshot',{detail:{bookings}})),rows.slice(0,2));
  await expect(workspace.locator('[data-calendar-day-view] [data-calendar-entry]')).toHaveCount(2);
  await expect(workspace.locator('[data-calendar-date-picker]')).toHaveValue('2027-01-01');
  await expect(workspace.locator('[data-calendar-add]')).toHaveCount(1);
});

test('AC-005: mobile gestures, keyboard focus and both themes remain usable at 320px', async ({ page }, info) => {
  await page.setViewportSize({width:320,height:780});
  await open(page, info);
  const workspace=page.locator('#calendarPanel .admin-calendar');
  await workspace.locator('[data-calendar-month-picker]').fill('2026-12');
  const grid=page.locator('#adminCalendarGrid');
  const gesture=async (endX,endY,cancel=false)=>grid.evaluate((node,{endX,endY,cancel})=>{
    node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'touch',isPrimary:true,clientX:250,clientY:100}));
    node.dispatchEvent(new PointerEvent(cancel?'pointercancel':'pointerup',{bubbles:true,pointerId:1,pointerType:'touch',isPrimary:true,clientX:endX,clientY:endY}));
  },{endX,endY,cancel});
  await gesture(245,240);
  await expect(page.locator('#adminCalendarMonthTitle')).toContainText('2026年12月');
  await gesture(50,105,true);
  await expect(page.locator('#adminCalendarMonthTitle')).toContainText('2026年12月');
  await gesture(50,105);
  await expect(page.locator('#adminCalendarMonthTitle')).toContainText('2027年1月');
  const clipped = await grid.locator('.admin-calendar-day-number').evaluateAll(numbers => numbers.filter(number => {
    const range=document.createRange(); range.selectNodeContents(number);
    const text=range.getBoundingClientRect(), cell=number.closest('.admin-calendar-day').getBoundingClientRect();
    return text.left < cell.left || text.right > cell.right;
  }).map(number=>number.textContent));
  expect(clipped, 'All date digits fit inside their own day tile').toEqual([]);
  const day=grid.locator('button[data-admin-calendar-date="2027-01-01"]');
  await day.focus();
  await page.keyboard.press('Enter');
  const add=workspace.locator('[data-calendar-add]');
  await add.click();
  await page.keyboard.press('Escape');
  await expect(workspace.locator('[data-calendar-create-menu]')).toBeHidden();
  await expect(add).toBeFocused();
  for(const theme of ['light','dark']) {
    await page.evaluate(value=>window.LumenTheme.set(value),theme);
    const colors=await workspace.locator('[data-calendar-day-view]').evaluate(node=>({fg:getComputedStyle(node).color,bg:getComputedStyle(node).backgroundColor}));
    expect(colors.fg).not.toBe(colors.bg);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  }
});
