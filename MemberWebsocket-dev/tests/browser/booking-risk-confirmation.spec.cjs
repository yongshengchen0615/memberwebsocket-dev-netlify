const {test,expect}=require('playwright/test'),path=require('node:path');
const setup=require('../integration/fixtures/booking-event-setup.cjs');
for(const width of [390,1280])test(`AC-RISK-UX-002_005_009_${width} — keyboard confirmation, cancellation and SQL history`,async({page},info)=>{
 const h=await setup();try{
  const {helpers}=require('../integration/fixtures/booking-risk-cases.cjs'),x=await helpers(h);
  await x.enable();await x.save({threshold_count:1});const booking=await x.past(await h.make());await x.mark(booking);
  const before=(await x.risk('get')).restrictions[0];
  await page.setViewportSize({width,height:900});
  await page.setContent('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="bookingPanel"><main></main></div></html>');
  await page.addStyleTag({path:path.resolve(__dirname,'../../admin/booking-panel.css')});
  await page.addScriptTag({path:path.resolve(__dirname,'../../admin/booking-risk.js')});
  await page.exposeFunction('riskRequest',(action,body)=>x.risk(action,body.policy||body));
  await page.evaluate(data=>window.BookingRiskSettings.mount(document.querySelector('main'),{data,request:window.riskRequest}),await x.risk('get'));
  await expect(page.getByText('限制：'+before.id+'；來源預約：'+booking,{exact:true})).toBeVisible();
  const reason=page.getByLabel('撤銷／解除／回覆原因（必填）'),revoke=page.getByRole('button',{name:'撤銷誤判',exact:true});
  await reason.fill('合成誤判核對');
  page.once('dialog',async d=>{expect(d.message()).toContain(booking);expect(d.message()).toContain('QA-NOTIFY');expect(d.message()).toContain('合成誤判核對');await d.dismiss();});
  await revoke.focus();await page.keyboard.press('Enter');
  await expect(revoke).toBeFocused();await expect(reason).toHaveValue('合成誤判核對');expect((await x.status()).restricted).toBe(true);
  page.once('dialog',d=>d.accept());await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('已撤銷');await expect(page.getByRole('status')).toBeFocused();
  expect((await x.status()).restricted).toBe(false);
  const after=await x.risk('get');expect(after.events[0].revoke_reason).toBe('合成誤判核對');expect(after.restrictions[0].policy_snapshot).toEqual(before.policy_snapshot);expect(after.restrictions[0].ends_at).toBe(before.ends_at);
  expect((await h.q("select count(*)::int n from S.booking_audit_events where action='BOOKING_RISK_REVOKE'"))[0].n).toBe(1);
  await page.getByLabel('啟用限制',{exact:true}).uncheck();page.once('dialog',async d=>{expect(d.message()).toContain('紀錄不刪除');await d.dismiss();});
  await page.getByRole('button',{name:'儲存政策'}).click();expect((await x.risk('get')).policy.enabled).toBe(true);
  await expect(page.getByLabel('啟用限制',{exact:true})).not.toBeChecked();await expect(page.getByRole('button',{name:'儲存政策'})).toBeFocused();
  page.once('dialog',d=>d.accept());await page.keyboard.press('Enter');await expect(page.getByRole('status')).toContainText('政策已儲存');
  expect((await x.risk('get')).policy.enabled).toBe(false);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await info.attach('risk-policy-history-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await h.db.close();}
});
