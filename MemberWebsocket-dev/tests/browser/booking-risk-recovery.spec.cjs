const {test,expect}=require('playwright/test'),path=require('node:path');
for(const width of [390,1280])test(`AC-RISK-UX-004_${width} — failed operation keeps reason, unlocks controls and prevents concurrent actions`,async({page})=>{
 page.on('dialog',dialog=>dialog.accept());
 await page.setViewportSize({width,height:900});
 await page.setContent('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><main></main></html>');
 await page.addScriptTag({path:path.resolve(__dirname,'../../admin/booking-risk.js')});
 await page.evaluate(()=>{
  window.riskCalls=[];window.BookingRiskSettings.mount(document.querySelector('main'),{data:{policy:{enabled:false,version:1},events:[{booking_id:'synthetic-booking',member_code:'SYNTHETIC',occurred_at:'2026-01-01T00:00:00Z'}],restrictions:[{id:'synthetic-restriction',starts_at:'2026-01-01T00:00:00Z',ends_at:'2099-01-01T00:00:00Z'}]},request:(action,body)=>{window.riskCalls.push({action,body});return new Promise((resolve,reject)=>{window.finishRiskRequest={resolve,reject};});}});
 });
 const reason=page.getByLabel('撤銷／解除原因（必填）'),revoke=page.getByRole('button',{name:'撤銷誤判',exact:true}),release=page.getByRole('button',{name:'人工解除',exact:true});
 await reason.fill('核對合成紀錄後撤銷');await revoke.click();await expect(release).toBeDisabled();await expect(reason).toBeDisabled();await expect(page.locator('#bookingRiskSettings')).toHaveAttribute('aria-busy','true');
 await page.evaluate(()=>window.finishRiskRequest.reject(Error('合成暫時失敗')));await expect(revoke).toBeEnabled();await expect(reason).toHaveValue('核對合成紀錄後撤銷');await expect(page.getByRole('status')).toContainText('輸入內容已保留');
 await revoke.focus();await page.keyboard.press('Enter');expect(await page.evaluate(()=>window.riskCalls)).toEqual([{action:'revoke',body:{bookingId:'synthetic-booking',reason:'核對合成紀錄後撤銷'}},{action:'revoke',body:{bookingId:'synthetic-booking',reason:'核對合成紀錄後撤銷'}}]);
 await page.evaluate(()=>window.finishRiskRequest.reject(Error('合成第二次失敗')));await expect(revoke).toBeEnabled();await expect(page.locator('#bookingRiskSettings')).toHaveAttribute('aria-busy','false');
});
