const { test, expect }=require('playwright/test');
const path=require('node:path');
const fs=require('node:fs');
const root=path.resolve(__dirname,'../..');

function withHooks(file, name, fields) {
  const source = fs.readFileSync(path.join(root, file), 'utf8').trimEnd();
  if (!source.endsWith('})();')) throw Error('Unable to install booking context test hooks');
  return source.slice(0, -5) + `window.${name} = {${fields}};\n})();`;
}

for (const rule of ['party', 'second participant service', 'second participant amount', 'shared store amount']) {
  test(`USAGE AC-003 refresh retains an eligible ${rule} ticket with the real group and app scripts`, async ({ page }) => {
    await page.setContent(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><body>
      <div id="servicePicker"></div><div id="serviceEmpty"><strong></strong></div>
      <div id="selectedServiceList"></div><div id="selectedServiceEmpty"></div>
      <section id="bookingBenefits"><div id="bookingBenefitsStatus" role="status" tabindex="-1"></div>
      <button id="bookingBenefitsRetry">重試</button><div id="bookingBenefitsList"></div></section></body></html>`);
    await page.evaluate(rule => {
      const services = [
        { serviceId: 'A', title: '頭療', priceAmount: 200, durationMinutes: 30, isActive: true },
        { serviceId: 'B', title: '按摩', priceAmount: 500, durationMinutes: 60, isActive: true },
        { serviceId: '00000000-0000-4000-8000-000000000010', title: '店內服務', priceAmount: 100, durationMinutes: 10, isActive: true },
      ];
      window.__services = services;
      window.BookingSystem = {
        request: async (_config, _role, _token, action) => action === 'user.booking.bootstrap'
          ? { services, bookings: [], settings: {} }
          : { settings: { maxPartySize: 5 }, technicians: [], bookingGroups: {} },
        bookingBenefits: async () => ({ eventTicketMaxPerDay: 0, pointTicketMaxPerRedemption: 0,
          items: [{ kind: 'event', id: 'E-REFRESH', selectionId: 'CLM-REFRESH', title: '多人活動票券', selectable: true,
            minBookingPartySize: rule === 'party' ? 2 : 0, maxBookingPartySize: rule === 'party' ? 2 : 0,
            requiredServiceIds: rule === 'second participant service' ? ['B'] : [],
            minBookingAmountMode: rule === 'second participant amount' ? 'selected_services' : rule === 'shared store amount' ? 'total' : 'none',
            minBookingAmount: rule === 'second participant amount' ? 500 : rule === 'shared store amount' ? 800 : 0,
            minBookingServiceIds: rule === 'second participant amount' ? ['B'] : [],
          }] }),
      };
    }, rule);
    await page.addScriptTag({ path: path.join(root, 'booking/booking-benefits.js') });
    await page.addScriptTag({ content: withHooks('booking/group-booking.js', '__groupContextTest', 'state, syncBenefitServiceContext') });
    await page.addScriptTag({ content: withHooks('booking/app.js', '__appContextTest', 'state, els, renderServices') });
    await page.evaluate(async () => {
      await window.BookingSystem.request({}, 'member', 'synthetic-token', 'user.booking.bootstrap');
      const group = window.__groupContextTest;
      group.state.partySize = 2;
      group.state.primaryItems = [{ serviceId: 'A', quantity: 1 }];
      group.state.extras = [[{ serviceId: 'B' }]];
      const app = window.__appContextTest;
      app.state.data = { services: window.__services, settings: {} };
      app.state.selections = [{ serviceId: 'A', selectionId: 'selection-A' }];
      for (const id of ['servicePicker', 'serviceEmpty', 'selectedServiceList', 'selectedServiceEmpty']) app.els[id] = document.getElementById(id);
      group.syncBenefitServiceContext();
      window.BookingBenefits.start({}, 'synthetic-token');
    });
    const choose = page.locator('input[data-booking-benefit-kind="event"]');
    await expect(choose).toBeEnabled();
    await choose.check();
    expect(await page.evaluate(() => window.BookingBenefits.selectionPayload())).toEqual([{ kind: 'event', id: 'CLM-REFRESH' }]);
    await page.evaluate(() => {
      window.__appContextTest.renderServices();
      window.__groupContextTest.syncBenefitServiceContext();
    });
    await expect(choose).toBeChecked();
    expect(await page.evaluate(() => window.BookingBenefits.selectionPayload())).toHaveLength(1);
    await page.evaluate(() => {
      window.__groupContextTest.state.partySize = 1;
      window.__groupContextTest.state.extras = [];
      window.__appContextTest.renderServices();
      window.__groupContextTest.syncBenefitServiceContext();
    });
    await expect(choose).toBeDisabled();
    expect(await page.evaluate(() => window.BookingBenefits.selectionPayload())).toEqual([]);
  });
}

test('AC-REVIEW-002: booking UI disables ineligible ticket and drops retained selection when party shrinks',async({page})=>{
  await page.setViewportSize({width:390,height:800});
  await page.setContent(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
    <section id="bookingBenefits">
      <div id="bookingBenefitsStatus" tabindex="-1" role="status"></div>
      <button id="bookingBenefitsRetry" type="button">重試</button>
      <div id="bookingBenefitsList"></div>
    </section></html>`);
  await page.evaluate(()=>{
    window.__backendCalls=[];
    window.BookingSystem={
      bookingBenefits:async(_config,_idToken,bookingId)=>{
        window.__backendCalls.push(bookingId);
        return {
          eventTicketMaxPerDay:0,pointTicketMaxPerRedemption:0,
          items:[{kind:'event',id:'E-GROUP',selectionId:'CLM-GROUP',title:'多人活動票券',
            status:'available',selectable:true,minBookingAmountMode:'none',
            minBookingPartySize:2,maxBookingPartySize:3,
            minBookingPartySizeLabel:'每筆預約需 2–3 位'}]
        };
      }
    };
  });
  await page.addScriptTag({path:path.join(root,'booking/booking-benefits.js')});
  await page.evaluate(()=>{
    window.__benefitEvents=[];
    window.addEventListener('booking:benefits-changed',event=>window.__benefitEvents.push(event.detail.benefits));
    window.BookingBenefits.setServiceContext([{serviceId:'A',amount:500}],1);
    window.BookingBenefits.start({test:true},'synthetic-token');
  });
  const choose=page.locator('input[data-booking-benefit-kind="event"]');
  await expect(choose).toBeDisabled();
  await expect(page.locator('.booking-benefit-disabled-reason')).toContainText('預約人數不符合');
  await page.evaluate(()=>window.BookingBenefits.setServiceContext([{serviceId:'A',amount:500}],2));
  await expect(choose).toBeEnabled();
  await choose.check();
  await expect.poll(()=>page.evaluate(()=>window.BookingBenefits.selectionPayload().length)).toBe(1);
  await page.evaluate(()=>window.BookingBenefits.setServiceContext([{serviceId:'A',amount:500}],1));
  await expect(choose).toBeDisabled();
  await expect.poll(()=>page.evaluate(()=>window.BookingBenefits.selectionPayload().length)).toBe(0);
  await expect(page.locator('#bookingBenefitsStatus')).toContainText('已自動取消');
  await page.evaluate(()=>window.BookingBenefits.setServiceContext([{serviceId:'A',amount:500}],3));
  await expect(choose).toBeEnabled();
  await page.evaluate(()=>window.BookingBenefits.setServiceContext([{serviceId:'A',amount:500}],4));
  await expect(choose).toBeDisabled();
  const emissions=await page.evaluate(()=>window.__benefitEvents);
  expect(emissions.some(x=>x.length===1)).toBe(true);
  expect(emissions.at(-1)).toEqual([]);
});
