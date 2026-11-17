const { test, expect } = require('playwright/test');
const { startFixture, transport } = require('./admin-fixture.cjs');
let host;
test.beforeAll(async () => { host = await startFixture(); });
test.afterAll(async () => { await host.close(); });

const activities = () => ({
  presence: [
    {event:'online',surface:'member',occurredAt:'2026-11-17T08:00:00Z'},
    {event:'offline',surface:'points',occurredAt:'2026-11-17T09:00:00Z'},
  ],
  pointCards: [
    {recordType:'point_entry',entryType:'grant',amount:3,title:'管理員贈點',occurredAt:'2026-11-17T06:00:00Z'},
    {recordType:'point_entry',entryType:'redeem',amount:-2,title:'兌換扣點',occurredAt:'2026-11-17T07:00:00Z'},
    {recordType:'point_ticket',title:'集點獎勵券',status:'available',occurredAt:'2026-11-17T10:00:00Z'},
  ],
  eventTickets: [
    {ticketType:'coupon',title:'折扣優惠',status:'claimed',occurredAt:'2026-11-17T11:00:00Z'},
    {ticketType:'lottery',title:'抽獎活動',status:'used',occurredAt:'2026-11-17T12:00:00Z'},
    {ticketType:'future',title:'<img src=x onerror=alert(1)>',occurredAt:'2026-11-17T13:00:00Z'},
  ],
  calendar: [{itemType:'event',title:'週年活動',occurredAt:'2026-11-17'}],
  bookings: [
    {status:'pending',title:'待確認服務',occurredAt:'2026-11-17T14:00:00Z'},
    {status:'confirmed',cancellationRequestedAt:'2026-11-17T15:00:00Z',title:'申請取消服務',occurredAt:'2026-11-17T15:00:00Z'},
    {status:'completed',cancellationRequestedAt:'2026-11-16T15:00:00Z',title:'已完成服務',occurredAt:'2026-11-17T16:00:00Z'},
  ],
});

for (const [device, viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
  test.describe(device, () => {
    test.use({viewport});
    test.beforeEach(async ({page}, info) => {
      const run = info.testId;
      info.activityRows = activities(); info.historyCalls = []; info.browserErrors = [];
      page.on('pageerror', e => info.browserErrors.push(e.message));
      // Replace external I/O only; production rendering and filtering run unchanged.
      await page.route(host.base+'/functions/v1/**', async route => {
        const {action,operation,...payload} = route.request().postDataJSON();
        const session = host.sessions.get(run);
        try {
          let data;
          if (action === 'admin.member-records.list') {
            info.historyCalls.push(payload.lineUserId);
            const records = payload.lineUserId === session.members[0].lineUserId ? info.activityRows : {};
            data = {member:session.members.find(m=>m.lineUserId===payload.lineUserId),records,counts:Object.fromEntries(Object.entries(records).map(([k,v])=>[k,v.length]))};
          } else data = await transport(session, action||operation, payload, new URL(route.request().url()).pathname.split('/').at(-1));
          return route.fulfill({json:{ok:true,data}});
        } catch (e) { return route.fulfill({status:400,json:{ok:false,error:{code:e.code,message:e.message}}}); }
      });
      await page.route(/https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
      // Expose the real application's realtime callback for deterministic refreshes.
      await page.route(host.base+'/fixture.js', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace('subscribeRealtime:()=>()=>{}', 'subscribeRealtime:(config,surface,callback)=>{window.activityRefresh=callback;return ()=>{};}');
        await route.fulfill({response,body});
      });
      await page.goto(host.base+'/admin/?run='+run);
      await expect(page.locator('#adminView')).toBeVisible();
      await page.locator('#memberUsageTab').click();
      await expect(page.locator('#memberUsageSelect')).toBeEnabled();
      const member = host.sessions.get(run).members[0];
      await page.locator('#memberUsageSelect').selectOption(member.lineUserId);
      await expect(page.locator('#memberRecordsList article')).toHaveCount(12);
    });
    test.afterEach(async ({page}, info) => {
      expect(info.browserErrors).toEqual([]);
      await info.attach('activity-evidence',{body:JSON.stringify({historyRequests:info.historyCalls,errors:info.browserErrors}),contentType:'application/json'});
    });

    test('AC-001/002/004: finer types, counts, zero results, safe labels and no additional requests', async ({page},info) => {
      const subtype = page.locator('#memberRecordsSubfilter');
      await expect(subtype).toBeDisabled();
      const requestCount = info.historyCalls.length;
      for (const [category, subtypeValue, count, title] of [
        ['presence','online',1,'會員上線'], ['presence','offline',1,'會員下線'],
        ['pointCards','grant',1,'管理員贈點'], ['pointCards','point_ticket',1,'集點獎勵券'],
        ['eventTickets','coupon',1,'折扣優惠'], ['eventTickets','lottery',1,'抽獎活動'],
        ['calendar','event',1,'週年活動'], ['bookings','cancellation_requested',1,'申請取消服務'],
        ['bookings','completed',1,'已完成服務'],
      ]) {
        await page.locator('[data-record-filter="'+category+'"]').click();
        await subtype.selectOption(subtypeValue);
        await expect(page.locator('#memberRecordsList article')).toHaveCount(count);
        await expect(page.locator('#memberRecordsList')).toContainText(title);
        await expect(page.locator('#memberRecordsFilterStatus')).toContainText('顯示 1 /');
      }
      await page.locator('[data-record-filter="presence"]').click();
      await expect(subtype.locator('option[value="online"]')).toHaveText('上線 1');
      await subtype.selectOption('other');
      await expect(page.locator('#memberRecordsEmpty')).toBeVisible();
      await expect(page.locator('#memberRecordsFilterStatus')).toContainText('顯示 0 / 2 筆');
      await page.locator('[data-record-summary-filter="eventTickets"]').click();
      await expect(subtype).toHaveValue('all');
      await subtype.selectOption('other');
      await expect(page.locator('#memberRecordsList')).toContainText('<img src=x onerror=alert(1)>');
      await expect(page.locator('#memberRecordsList img')).toHaveCount(0);
      expect(info.historyCalls).toHaveLength(requestCount);
      const bounds = await subtype.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x+bounds.width).toBeLessThanOrEqual(viewport.width);
      await info.attach('activity-'+device,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
    });

    test('AC-003: realtime preserves subtype and switching member clears it and prior records', async ({page},info) => {
      await page.locator('[data-record-filter="presence"]').click();
      await page.locator('#memberRecordsSubfilter').selectOption('online');
      info.activityRows.presence.push({event:'online',surface:'booking',occurredAt:'2026-11-17T18:00:00Z'});
      await page.evaluate(() => window.activityRefresh());
      await expect(page.locator('#memberRecordsList article')).toHaveCount(2);
      await expect(page.locator('#memberRecordsSubfilter')).toHaveValue('online');
      await expect(page.locator('#memberRecordsFilterStatus')).toContainText('顯示 2 / 3 筆');
      const second = host.sessions.get(info.testId).members[1];
      await page.locator('#memberUsageSelect').selectOption(second.lineUserId);
      await expect(page.locator('#memberRecordsList article')).toHaveCount(0);
      await expect(page.locator('#memberRecordsSubfilter')).toHaveValue('all');
      await expect(page.locator('#memberRecordsSubfilter')).toBeDisabled();
      await expect(page.locator('#memberRecordsEmpty')).toBeVisible();
      await expect(page.locator('#memberRecordsFilterStatus')).toContainText('顯示 0 / 0 筆');
    });
  });
}
