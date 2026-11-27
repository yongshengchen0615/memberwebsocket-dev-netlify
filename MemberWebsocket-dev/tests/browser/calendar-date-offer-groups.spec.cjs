const { test, expect } = require('playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const file = name => fs.readFileSync(path.join(root, 'calendar', name));
const available = {
  itemType: 'event', calendarItemId: 'public-ticket', title: '一般會員活動票券',
  startsOn: '2026-12-12', endsOn: '2026-12-12', tierEligible: true, locked: false,
  allowedTierLabels: ['一般會員'], linkLabel: '查看票券',
  linkUrl: 'https://older.example/event/?source=event-ticket-calendar&eventTicketId=EVT-A'
};
const locked = {
  itemType: 'event', calendarItemId: 'silver-event', title: '銀級專屬活動',
  startsOn: '2026-12-12', endsOn: '2026-12-12', tierEligible: false, locked: true,
  allowedTierLabels: ['銀級會員'], lockReason: '需符合銀級會員才可使用。',
  linkLabel: '參加活動', linkUrl: 'https://other.example/activity/'
};
const holiday = {
  itemType: 'holiday', calendarItemId: 'day-off', title: '技師休假',
  status: 'active', startsOn: '2026-12-12', endsOn: '2026-12-12'
};
const cases = {
  mixed: [available, locked],
  locked: [locked],
  holiday: [available, locked, holiday],
  hidden: []
};
const ids = [
  'loadingView','loadingProgress','loadingProgressBar','loadingProgressText','loadingStatus',
  'errorView','errorTitle','errorMessage','joinMemberButton','retryButton','calendarView',
  'displayName','membershipProgress','previousMonthButton','nextMonthButton','todayButton',
  'monthTitle','calendarSummary','calendarRangeNotice','calendarGrid','calendarOngoingTickets',
  'calendarOngoingTicketList','emptyView','calendarDetailModal','closeCalendarDetailButton',
  'calendarDetailTitle','calendarDetailDate','calendarDetailItems'
];
let server, base;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/calendar/app.js' || url.pathname === '/calendar/styles.css') {
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(file(url.pathname.endsWith('.css') ? 'styles.css' : 'app.js'));
      return;
    }
    if (url.pathname !== '/calendar/') { res.writeHead(404).end(); return; }
    const selected = cases[url.searchParams.get('case')] || cases.mixed;
    const fixture = JSON.stringify(selected).replace(/</g, '\\u003c');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="zh-Hant"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/calendar/styles.css"></head><body><div id="app" class="app-shell">'
      + ids.filter(id => !['calendarView','calendarGrid','calendarDetailModal','closeCalendarDetailButton','calendarDetailTitle','calendarDetailDate','calendarDetailItems'].includes(id))
          .map(id => '<div id="' + id + '"></div>').join('')
      + '<main id="calendarView"><section id="calendarGrid" class="calendar-grid"></section></main>'
      + '<div id="calendarDetailModal" class="calendar-detail-modal hidden" role="dialog"><div class="calendar-detail-card">'
      + '<button id="closeCalendarDetailButton">×</button><h2 id="calendarDetailTitle"></h2>'
      + '<p id="calendarDetailDate"></p><div id="calendarDetailItems"></div></div></div>'
      + '</div><script>window.__fixtureItems=' + fixture + ';'
      + 'window.MemberSystem={bindDialogKeyboard(){},loadConfig:async()=>({}),signIn:async()=>"fixture",request:async()=>({profile:{displayName:"測試會員",tierKey:"general"},items:window.__fixtureItems,ongoingTickets:[]}),subscribeRealtime(){return ()=>{}}};'
      + 'window.MembershipProgress={render(){}};window.MemberMonthlyTierBenefits={bind(){}};window.BusinessContext={slug:"merchant-a"};'
      + 'document.getElementById("calendarView").classList.add("hidden");document.getElementById("calendarDetailModal").classList.add("hidden");'
      + '</script><script src="/calendar/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function open(page, which) {
  await page.clock.setFixedTime(new Date('2026-12-12T04:00:00Z'));
  await page.goto(base + '/calendar/?case=' + which);
  await expect(page.locator('#calendarView')).toBeVisible();
  if (which !== 'hidden') {
    await page.locator('[data-calendar-date="2026-12-12"]').click();
    await expect(page.locator('#calendarDetailModal')).toBeVisible();
  }
}

for (const width of [320, 390, 1280]) {
  test('calendar date shows usable and locked offer groups without horizontal clipping at '+width+'px', async ({ page }, info) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({width, height: 800});
    await open(page, 'mixed');
    const modal = page.locator('#calendarDetailModal');
    await expect(modal.locator('.calendar-detail-group.available')).toContainText('當日可用的活動與票券');
    await expect(modal.locator('.calendar-detail-group.locked')).toContainText('未解鎖的活動與票券');
    await expect(modal.locator('.calendar-detail-group.available .calendar-detail-item')).toHaveCount(1);
    await expect(modal.locator('.calendar-detail-group.locked .calendar-detail-item')).toHaveCount(1);
    await expect(modal.locator('.calendar-detail-group.locked')).toContainText('需符合銀級會員');
    await expect(modal.locator('.calendar-detail-group.locked a')).toHaveCount(0);
    const link = modal.locator('.calendar-detail-group.available a');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', /eventTicketId=EVT-A.*business=merchant-a/);
    await expect(modal.locator('.calendar-detail-type').first()).toHaveText('活動票券');
    const overflow = await modal.locator('.calendar-detail-card').evaluate(el => ({
      card: el.scrollWidth > el.clientWidth + 1,
      page: document.documentElement.scrollWidth > window.innerWidth + 1
    }));
    expect(overflow).toEqual({card:false,page:false});
    await page.screenshot({path:info.outputPath('calendar-date-'+width+'.png')});
    expect(errors).toEqual([]);
  });
}

test('holiday remains exclusive and no unusable actions appear', async ({page}) => {
  await open(page, 'holiday');
  await expect(page.locator('.calendar-detail-group.notice')).toContainText('技師休假');
  await expect(page.locator('.calendar-detail-group.available')).toHaveCount(0);
  await expect(page.locator('.calendar-detail-group.locked')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#calendarDetailModal')).toBeHidden();
});

test('locked-only dates are visible and hidden items are not invented by the client', async ({page}) => {
  await open(page, 'locked');
  await expect(page.locator('.calendar-detail-group.locked')).toHaveCount(1);
  await expect(page.locator('.calendar-detail-group.available')).toHaveCount(0);
  await page.goto(base+'/calendar/?case=hidden');
  await expect(page.locator('#calendarView')).toBeVisible();
  await expect(page.locator('[data-calendar-date]')).toHaveCount(0);
});
