const {test,expect}=require('playwright/test'),path=require('node:path');
const setup=require('../integration/fixtures/booking-event-setup.cjs');
for(const width of [390,1280])test(`BOOKING_RISK_${width} — blank defaults, selected policy, persisted SQL and reason-required controls`,async({page})=>{
 page.on('dialog',dialog=>dialog.accept());
 const h=await setup();try{
  const risk=async(action,body={})=>(await h.q('select S.admin_booking_no_show($1,$2,$3) result',[h.owner,action,body.policy||body]))[0].result;
  await page.setViewportSize({width,height:900});
  await page.setContent('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><main></main></html>');
  await page.addScriptTag({path:path.resolve(__dirname,'../../admin/booking-risk.js')});
  await page.exposeFunction('riskRequest',risk);const data=await risk('get');
  await page.evaluate(data=>window.BookingRiskSettings.mount(document.querySelector('main'),{data,request:window.riskRequest}),data);
  await expect(page.getByLabel('啟用限制',{exact:true})).not.toBeChecked();await expect(page.getByLabel('達到幾次爽約')).toHaveValue('');
  await page.getByLabel('啟用限制',{exact:true}).check();await page.getByRole('button',{name:'儲存政策'}).click();await expect(page.getByRole('status')).toContainText('完整設定');
  for(const [label,value]of [['計次期間（天）','90'],['達到幾次爽約','3'],['限制期限數量','2'],['服務結束後寬限（分鐘）','15'],['電話預約／客服聯絡方式','合成客服，請來電核對']])await page.getByLabel(label,{exact:true}).fill(value);
  await page.getByLabel('限制期限單位').selectOption('weeks');await page.getByRole('button',{name:'儲存政策'}).click();
  await expect(page.getByRole('status')).toContainText('政策已儲存');
  await expect(page.getByLabel('啟用限制',{exact:true})).toBeChecked();await expect(page.getByLabel('限制期限數量')).toHaveValue('2');
  const persisted=await risk('get');expect(persisted.policy.enabled).toBe(true);expect(persisted.policy.duration_unit).toBe('weeks');expect(persisted.policy.threshold_count).toBe(3);
  await page.getByLabel('啟用限制',{exact:true}).uncheck();await page.getByRole('button',{name:'儲存政策'}).click();await expect(page.getByLabel('啟用限制',{exact:true})).not.toBeChecked();
  await expect(page.getByRole('status')).toContainText('政策已儲存');
  expect((await risk('get')).policy.enabled).toBe(false);
 }finally{await h.db.close();}
});
for(const width of [390,1280])test(`BOOKING_RISK_APPEAL_${width} — review persists once and explicit release restores eligibility`,async({page})=>{
 page.on('dialog',dialog=>dialog.accept());
 const h=await setup();try{
  const {helpers}=require('../integration/fixtures/booking-risk-cases.cjs'),x=await helpers(h);
  await x.enable();await x.save({threshold_count:1});const b=await x.past(await h.make());await x.mark(b);
  await h.q('select S.booking_no_show_appeal($1,$2)',[h.memberLine,'合成申覆，請核對']);
  const request=(action,body={})=>x.risk(action,body.policy||body);
  await page.setViewportSize({width,height:900});await page.setContent('<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><main></main></html>');
  await page.addScriptTag({path:path.resolve(__dirname,'../../admin/booking-risk.js')});await page.exposeFunction('riskRequest',request);
  await page.evaluate(data=>window.BookingRiskSettings.mount(document.querySelector('main'),{data,request:window.riskRequest}),await request('get'));
  await page.getByRole('button',{name:'記錄回覆',exact:true}).click();await expect(page.getByRole('status')).toContainText('核對原因');
  await page.getByLabel('撤銷／解除／回覆原因（必填）').fill('合成查核已完成');await page.getByRole('button',{name:'記錄回覆',exact:true}).click();
  await expect(page.getByText('合成申覆，請核對 · 已回覆',{exact:true})).toBeVisible();expect((await x.status()).restricted).toBe(true);
  await page.getByLabel('撤銷／解除／回覆原因（必填）').fill('核准本次人工解除');await page.getByRole('button',{name:'人工解除',exact:true}).click();
  await expect(page.getByRole('button',{name:'人工解除',exact:true})).toHaveCount(0);expect((await x.status()).restricted).toBe(false);
  const audits=await h.q("select action from S.booking_audit_events where action in ('BOOKING_RISK_RESOLVE','BOOKING_RISK_RELEASE')");expect(audits.map(r=>r.action).sort()).toEqual(['BOOKING_RISK_RELEASE','BOOKING_RISK_RESOLVE']);
 }finally{await h.db.close();}
});
