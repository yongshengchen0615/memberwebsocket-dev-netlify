const { test, expect } = require('playwright/test');
const { startFixture } = require('./admin-fixture.cjs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let host, server, base;
test.beforeAll(async () => {
  host = await startFixture();
  server = http.createServer((req,res) => {
    res.setHeader('Content-Type', req.url === '/benefits.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/benefits.js'
      ? fs.readFileSync(path.resolve(__dirname,'../../booking/booking-benefits.js'),'utf8')
      : '<!doctype html><html lang="zh-Hant"><body><section id="bookingBenefits"><p id="bookingBenefitsStatus" tabindex="-1"></p><button id="bookingBenefitsRetry"></button><div id="bookingBenefitsList"></div></section><script src="/benefits.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => {
  await host.close();
  await new Promise(resolve=>server.close(resolve));
});
async function openForm(page,testId) {
  await page.route('https://**', route => route.abort());
  await page.goto(host.base+'/admin/?run='+encodeURIComponent(testId));
  await expect(page.locator('#adminView')).toBeVisible();
  await page.locator('#eventsTab').click();
  await page.locator('#newEventTicketButton').click();
  await page.locator('#eventTicketTitle').fill('滿額預約活動券');
  await page.locator('#eventTicketDescription').fill('只在一般預約滿額使用');
  await page.locator('#eventTicketUsageMethod').fill('一般預約使用');
  await page.locator('#eventTicketUsageInstructions').fill('快照不受此金額限制');
  await page.locator('#eventTicketStatus').selectOption('active');
}

for (const width of [390,1280]) {
  test('AC-007: admin setting survives save/reload at '+width+'px',async({page},info)=>{
    await page.setViewportSize({width,height:850});
    await openForm(page,info.testId);
    const mode = page.locator('#eventTicketMinBookingAmountMode');
    await expect(mode).toHaveValue('none');
    await expect(page.locator('#eventTicketMinBookingAmountField')).toBeHidden();
    await mode.selectOption('selected_services');
    await page.locator('#eventTicketMinBookingAmount').fill('200');
    await expect(page.locator('#eventTicketMinBookingServicesField')).toBeVisible();
    await page.locator('#eventTicketMinBookingServiceIds input[value="service-2"]').check();
    await page.locator('#saveEventTicketButton').click();
    await expect.poll(()=>host.sessions.get(info.testId).eventTickets.length).toBe(1);
    const ticket=host.sessions.get(info.testId).eventTickets[0];
    expect(ticket.minBookingAmountMode).toBe('selected_services');
    expect(ticket.minBookingAmount).toBe(200);
    expect(ticket.minBookingServiceIds).toEqual(['service-2']);
    await page.reload();
    await expect(page.locator('#adminView')).toBeVisible();
    await page.locator('#eventsTab').click();
    await page.locator('[data-event-ticket-id="'+ticket.eventTicketId+'"]').first().click();
    await expect(mode).toHaveValue('selected_services');
    await expect(page.locator('#eventTicketMinBookingAmount')).toHaveValue('200');
    await expect(page.locator('#eventTicketMinBookingServiceIds input[value="service-2"]')).toBeChecked();
    expect(host.sessions.get(info.testId).unexpected).toEqual([]);
  });
}
test('AC-008: admin cannot silently lose minimum from stale server response',async({page},info)=>{
  await openForm(page,info.testId);
  const session=host.sessions.get(info.testId);
  session.legacyTicketApiDropsAmount=true;
  await page.locator('#eventTicketMinBookingAmountMode').selectOption('total');
  await page.locator('#eventTicketMinBookingAmount').fill('800');
  await page.locator('#saveEventTicketButton').click();
  await expect(page.locator('#eventTicketFormMessage')).toContainText('後端未保留最低預約金額');
  await expect(page.locator('#eventTicketMinBookingAmount')).toHaveValue('800');
  expect(session.calls.filter(x=>x.action==='admin.event-tickets.save')).toHaveLength(1);
});
for(const width of [390,1280]) {
  test('AC-009: general booking requires total or selected service price; selection invalidates when price falls at '+width,async({page})=>{
    await page.setViewportSize({width,height:800});
    await page.goto(base+'/');
    await page.evaluate(()=>{
      window.BookingSystem={bookingBenefits:async()=>({
        eventTicketMaxPerDay:0,pointTicketMaxPerRedemption:0,
        items:[
          {kind:'event',id:'total',title:'整筆滿300',selectionId:'CLAIM-TOTAL',selectable:true,
           minBookingAmountMode:'total',minBookingAmount:300,minBookingServiceIds:[],
           minBookingAmountLabel:'一般預約總金額滿 NT$300',conditionLabel:'一般預約總金額滿 NT$300'},
          {kind:'event',id:'selected',title:'指定項目滿200',selectionId:'CLAIM-SERVICE',selectable:true,
           minBookingAmountMode:'selected_services',minBookingAmount:200,minBookingServiceIds:['B'],
           minBookingAmountLabel:'一般預約指定項目 B 滿 NT$200',conditionLabel:'指定項目滿 NT$200'},
        ]})};
      window.BookingBenefits.start({},'test-token');
    });
    const rows=page.locator('#bookingBenefitsList .booking-benefit');
    await expect(rows).toHaveCount(2);
    const visibleConditions = rows.locator('.booking-benefit-amount-condition');
    await expect(visibleConditions).toHaveCount(2);
    await expect(visibleConditions.nth(0)).toHaveText('金額使用條件：一般預約總金額滿 NT$300');
    await expect(visibleConditions.nth(1)).toHaveText('金額使用條件：一般預約指定項目 B 滿 NT$200');
    await expect(rows.locator('input[type="checkbox"]:disabled')).toHaveCount(2);
    await page.evaluate(()=>window.BookingBenefits.setServiceContext([{serviceId:'A',amount:100},{serviceId:'B',amount:199}]));
    await expect(rows.locator('input[type="checkbox"]:disabled')).toHaveCount(2);
    await page.evaluate(()=>window.BookingBenefits.setServiceContext([{serviceId:'A',amount:100},{serviceId:'B',amount:200}]));
    await expect(rows.locator('input[type="checkbox"]:enabled')).toHaveCount(2);
    await rows.locator('input[data-booking-benefit-id="CLAIM-SERVICE"]').check();
    expect(await page.evaluate(()=>window.BookingBenefits.selectionPayload())).toEqual([{kind:'event',id:'CLAIM-SERVICE'}]);
    await page.evaluate(()=>window.BookingBenefits.setServiceContext([{serviceId:'A',amount:300},{serviceId:'B',amount:199}]));
    await expect(rows.locator('input[data-booking-benefit-id="CLAIM-TOTAL"]')).toBeEnabled();
    await expect(rows.locator('input[data-booking-benefit-id="CLAIM-SERVICE"]')).toBeDisabled();
    expect(await page.evaluate(()=>window.BookingBenefits.selectionPayload())).toEqual([]);
  });
}
