const { test, expect }=require('playwright/test');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');

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
