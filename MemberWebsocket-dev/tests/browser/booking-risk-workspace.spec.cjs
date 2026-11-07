const {test,expect}=require('playwright/test');
const path=require('node:path');
for(const width of [320,390,1280]){
 test('AC-RISK-UX-008 responsive policy workspace '+width,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.setContent('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="bookingPanel"><main></main></div></html>');
  await page.addStyleTag({path:path.resolve(__dirname,'../../admin/booking-panel.css')});
  await page.addScriptTag({path:path.resolve(__dirname,'../../admin/booking-risk.js')});
  await page.evaluate(()=>window.BookingRiskSettings.mount(document.querySelector('main'),{
   data:{policy:{enabled:false,version:1},events:[],restrictions:[],appeals:[]},
   request:async()=>{throw Error('no synthetic write authorized');},
  }));
  await expect(page.getByRole('heading',{name:'限制政策設定'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'爽約與限制紀錄'})).toBeVisible();
   await expect(page.getByText('會員申覆')).toHaveCount(0);
  const dimensions=await page.evaluate(()=>({
   doc:document.documentElement.scrollWidth,
   viewport:window.innerWidth,
   form:document.querySelector('.booking-risk-policy-form').getBoundingClientRect().width,
  }));
  expect(dimensions.doc).toBeLessThanOrEqual(dimensions.viewport+1);
  expect(dimensions.form).toBeLessThanOrEqual(dimensions.viewport+1);
  const layout=await page.evaluate(()=>({
    form:getComputedStyle(document.querySelector('.booking-risk-policy-form')).gridTemplateColumns.split(' ').length,
    countFields:getComputedStyle(document.querySelector('.booking-risk-field-group:nth-child(2) .booking-risk-field-grid')).gridTemplateColumns.split(' ').length,
    records:getComputedStyle(document.querySelector('.booking-risk-records')).gridTemplateColumns.split(' ').length,
  }));
  // AC-RISK-FIGMA-003: four policy steps stack in reading order even on desktop.
  // On 1280px, individual counting inputs still use three columns; records remain side by side.
  expect(layout.form).toBe(1);
  expect(layout.countFields).toBe(width===1280?3:1);
  expect(layout.records).toBe(width===1280?2:1);
  await expect(page.getByText('可設定 1–3650 天')).toBeVisible();
  await expect(page.locator('.booking-risk-record-section')).toHaveCount(2);
  await page.getByLabel('啟用限制',{exact:true}).check();
  await expect(page.locator('.booking-risk-draft')).toContainText('未儲存');
  await page.getByRole('button',{name:'還原變更'}).click();
  await expect(page.getByLabel('啟用限制',{exact:true})).not.toBeChecked();
 });
}
