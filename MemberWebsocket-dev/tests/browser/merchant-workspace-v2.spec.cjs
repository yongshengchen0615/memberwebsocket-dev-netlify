const {test,expect}=require('playwright/test'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {setup}=require('../integration/fixtures/merchant-http.cjs');
const root=path.resolve(__dirname,'../..');let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(pathname.endsWith('/')?pathname+'index.html':pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'application/json'});res.end(fs.readFileSync(file));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(resolve=>server.close(resolve)));
async function wire(page,h,token='manager',{loseAction=''}={}){
 const errors=[],calls=[];let lost=false;page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.route('**/config.json',route=>route.fulfill({json:{...JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8')),merchantApprovalVersion:2,realtimeEnabled:false,supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'sb_publishable_fixture'}}));
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:`window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>${JSON.stringify(token)}};`}));
 await page.route('https://*.tile.openstreetmap.org/**',route=>route.abort());
 await page.route('https://fixture.supabase.co/functions/v1/platform-api',async route=>{
  const req=route.request(),body=req.method()==='POST'?req.postDataJSON():undefined;if(body)calls.push(body);
  const headers=new Headers(req.headers());headers.set('Origin',base);const response=await h.handler(new Request(req.url(),{method:req.method(),headers,...(body?{body:JSON.stringify(body)}:{})}));
  if(!lost&&body?.action===loseAction&&response.ok){lost=true;return route.abort('failed');}
  return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
 });return{errors,calls};
}
async function sendMerchant(page,name){await expect(page.locator('#merchantApplicationForm [name="slug"]')).toHaveCount(0);await page.locator('#merchantApplicationForm [name="businessName"]').fill(name);await page.locator('#submitMerchantApplication').click();}
async function reviewMerchant(page,slug,decision='approved',feature='points'){
 await page.reload();await page.locator('#applicationList article').filter({hasText:slug}).locator(`[data-review-decision="${decision}"]`).click();
 if(decision==='approved')await page.locator(`[data-v2-feature="${feature}"]`).check();else await page.locator('#reviewReason').fill('請補上商家證明');
 await page.locator('#confirmV2Review').click();await expect(page.locator('#v2ReviewDialog')).not.toBeVisible();
}
test('V2_REAL_HANDLER_JOURNEY — explicit qualification, root decisions, independent A/B, uncertain retry and scoped LINE saves',async({page,context},info)=>{
 test.setTimeout(60000);await page.setViewportSize({width:390,height:844});const h=await setup({origins:[base]}),rootPage=await context.newPage();try{
  const account=await wire(page,h,'manager',{loseAction:'platform.merchant.submit'}),reviewer=await wire(rootPage,h,'root');
  await page.goto(base+'/admin/');await expect(page.locator('#qualificationWorkspace')).toBeVisible();expect(await h.count('admin_qualifications')).toBe(0);expect(await h.count('applications')).toBe(0);
  await page.locator('#submitQualification').click();await expect(page.locator('#qualificationStatus')).toContainText('等待');expect(await h.count('admin_qualifications')).toBe(1);expect(await h.count('applications')).toBe(0);
  await rootPage.goto(base+'/platform/');await expect(rootPage.locator('#qualificationList article')).toHaveCount(1);await rootPage.locator('#qualificationList [data-review-decision="approved"]').click();await rootPage.locator('#confirmV2Review').click();await expect(rootPage.locator('#v2ReviewDialog')).not.toBeVisible();
  await page.locator('#refreshApplication').click();await expect(page.locator('#myMerchantsWorkspace')).toBeVisible();await sendMerchant(page,'商家 A');await expect(page.locator('#submitMerchantApplication')).toHaveText('重試相同商家申請');await expect(page.locator('#merchantApplicationForm [name="businessName"]')).toBeDisabled();await page.locator('#submitMerchantApplication').click();
  await expect(page.locator('#myMerchantList article')).toHaveCount(1);expect(await h.count('applications')).toBe(1);const submits=account.calls.filter(x=>x.action==='platform.merchant.submit');expect(submits).toHaveLength(2);expect(submits[0]).toEqual(submits[1]);await expect(page.locator('[data-manage-merchant]')).toHaveCount(0);
  const a=(await h.list()).find(x=>x.businessName==='商家 A');expect(a.slug).toMatch(/^m-[a-f0-9]{32}$/);await reviewMerchant(rootPage,a.slug);await page.locator('#refreshApplication').click();await expect(page.locator('[data-manage-merchant]')).toHaveCount(1);
  await page.locator('#newMerchantApplication').click();await sendMerchant(page,'商家 B');await expect(page.locator('#myMerchantList article')).toHaveCount(2);await expect(page.locator('[data-manage-merchant]')).toHaveCount(1);const b=(await h.list()).find(x=>x.businessName==='商家 B');expect(b.slug).not.toBe(a.slug);await reviewMerchant(rootPage,b.slug,'rejected');
  await page.locator('#refreshApplication').click();const bCard=page.locator('#myMerchantList article').filter({hasText:b.slug});await expect(bCard).toContainText('請補上商家證明');await bCard.locator('[data-resubmit-merchant]').click();await page.locator('#merchantApplicationForm [name="businessName"]').fill('商家 B 修正');await page.locator('#submitMerchantApplication').click();await expect(bCard).toContainText('等待商家審核');
  await reviewMerchant(rootPage,b.slug,'approved','booking');await page.locator('#refreshApplication').click();await expect(page.locator('[data-manage-merchant]')).toHaveCount(2);await expect(page).toHaveURL(base+'/admin/');
  const last=account.calls.filter(x=>x.action==='platform.merchant.submit').at(-1);expect(last.expectedVersion).toBe(2);expect(last.slug).toBeUndefined();expect((await h.get(b.id)).slug).toBe(b.slug);expect(last.applicationId).toBeTruthy();for(const input of account.calls.filter(x=>/^platform\.(qualification|merchant)\./.test(x.action)))expect(input.business).toBeUndefined();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('#myMerchantList article').filter({hasText:a.slug}).locator('[data-merchant-line]').click();await expect(page).toHaveURL(base+'/admin/workspace.html?business='+a.slug);await expect(page.locator('#merchantWorkspace')).toBeVisible();await expect(page.locator('#applicationWorkspace')).toBeHidden();await page.locator('#merchantLineSettingsTab').click();
  for(const [key,value]of Object.entries({adminChannelId:'2010791619',memberChannelId:'2010123456',messagingChannelId:'2010123456',adminLiffId:'2010791619-admin',channelAccessToken:'synthetic-token-a-00000',channelSecret:'a'.repeat(32)}))await page.locator(`#merchantLineForm [name="${key}"]`).fill(value);
  await page.locator('#saveMerchantLine').click();await expect(page.locator('#merchantMessage')).toContainText('已安全儲存');await page.locator('[data-line-feature="points"]').click();await page.locator('#merchantLineForm [name="pointsLiffId"]').fill('2010123456-points-a');await page.locator('#saveMerchantLine').click();await expect(page.locator('#merchantMessage')).toContainText('已安全儲存');
  const tenants=(await h.db.query('select slug,line_config,features from platform_private.tenants order by slug')).rows;expect(tenants).toHaveLength(2);expect(tenants.find(t=>t.slug===a.slug).line_config.pointsLiffId).toBe('2010123456-points-a');expect(tenants.find(t=>t.slug===a.slug).features.points).toBe(true);expect(tenants.find(t=>t.slug===b.slug).line_config).toEqual({});expect(tenants.find(t=>t.slug===b.slug).features.booking).toBe(true);
  await page.locator('[data-business-switch="true"]').click();await expect(page).toHaveURL(base+'/admin/');await expect(page.locator('#myMerchantList article')).toHaveCount(2);expect(account.errors).toEqual([]);expect(reviewer.errors).toEqual([]);await info.attach('v2-my-merchants-mobile',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await rootPage.close();await page.close();await h.db.close();}
});
test('V2_REVOCATION — reads clear account cards and selected LINE secrets after qualification suspension',async({page,context})=>{
 test.setTimeout(45000);const h=await setup({origins:[base]}),settings=await context.newPage();try{
  const q=await h.qualify(),a=await h.submit(h.owner,'browser-revoke','Revocation');await h.review(a);const account=await wire(page,h),selected=await wire(settings,h);
  await page.goto(base+'/admin/');await expect(page.locator('[data-manage-merchant]')).toHaveCount(1);await settings.goto(base+'/admin/workspace.html?business=browser-revoke');await expect(settings.locator('#merchantWorkspace')).toBeVisible();await settings.locator('#merchantLineSettingsTab').click();await settings.locator('#merchantLineForm [name="channelAccessToken"]').fill('unsaved-private-draft');
  await h.call('platform_review_admin_qualification',[h.root,q.id,q.version,'suspended','資格停用',crypto.randomUUID()]);await page.locator('#refreshApplication').click();await expect(page.locator('#myMerchantsWorkspace')).toBeHidden();await expect(page.locator('#myMerchantList article')).toHaveCount(0);await expect(page.locator('#qualificationStatus')).toContainText('停用');
  await settings.locator('#refreshApplication').click();await expect(settings.locator('#merchantWorkspace')).toBeHidden();expect(await settings.locator('#merchantLineForm [name="channelAccessToken"]').inputValue()).toBe('');expect(account.calls.filter(x=>x.action==='platform.qualification.submit')).toHaveLength(0);expect(selected.calls.filter(x=>/^platform\.(qualification|merchant)\./.test(x.action))).toHaveLength(0);expect(account.errors).toEqual([]);expect(selected.errors).toEqual([]);
 }finally{await settings.close();await page.close();await h.db.close();}
});
