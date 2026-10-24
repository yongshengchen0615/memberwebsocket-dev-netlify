const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {fixture}=require('../integration/platform-fixture.cjs');
const root=path.resolve(__dirname,'../..');
let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(root,'.'+(pathname.endsWith('/')?pathname+'index.html':pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/json'});res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(resolve=>server.close(resolve)));
async function setup(page,token='root',{loseFirstSave=false,loseFirstLineSave=false,platformLiffId='2012065297-VunxFBj8',inClient=true,loggedIn=true,rootLoginReturn=true,entry='platform',manualGrant=true}={}) {
 const h=await fixture(1,manualGrant);h.allowedOrigins.add(base);let lost=false;const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 if(rootLoginReturn&&token==='root')await page.addInitScript(()=>{
  // Simulate a genuine LINE return for the pre-existing root-control cases.
  sessionStorage.setItem('platform-line-login-return-v1',String(Date.now()));
 });
 await page.route('**/config.json',route=>route.fulfill({json:{brandName:'QA Platform',supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'sb_publishable_fixture',adminLiffId:'2010791619-admin',productizedAdmin:true,platformLiffId}}));
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:`window.loginCalls=[];window.logoutCalls=0;window.liff={init:async options=>{window.initializedLiffId=options.liffId;},isInClient:()=>${inClient},isLoggedIn:()=>${loggedIn}||sessionStorage.getItem('qaLoggedIn')==='1',login:(...args)=>{window.loginCalls.push(args);},logout:()=>{window.logoutCalls+=1;sessionStorage.setItem('qaRootLogoutCount',String(Number(sessionStorage.getItem('qaRootLogoutCount')||'0')+1));},getIDToken:()=>${JSON.stringify(token)}};`}));
 // A legacy Leaflet map can request OpenStreetMap tiles even while the admin
 // workspace is hidden. Unavailable remote images must not block goto(load)
 // or make the application/authorization E2E depend on a third-party CDN.
 await page.route('https://*.tile.openstreetmap.org/**',route=>route.fulfill({
  status:200,contentType:'image/png',
  body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==','base64')
 }));
 await page.route('https://fixture.supabase.co/functions/v1/platform-api',async route=>{
  const method=route.request().method();
  const input=method==='POST'?route.request().postDataJSON():null;
  const headers=new Headers(route.request().headers());headers.set('Origin',base);
  const response=await h.handler(new Request(route.request().url(),{method,headers,...(method==='POST'?{body:JSON.stringify(input)}:{})}));
  if(loseFirstSave&&!lost&&input?.action==='platform.tenant.features.save'){lost=true;return route.abort('failed');}
  if(loseFirstLineSave&&!lost&&input?.action==='platform.line.save'){lost=true;return route.abort('failed');}
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
 });
 await page.goto(base+(entry==='admin'?'/admin/':'/platform/'));return {...h,errors};
}

async function submitMerchantApplication(page,name='測試商家',slug='ui-manual-review') {
 await expect(page.locator('#applicationForm')).toBeVisible();
 await page.locator('#applicationForm [name="businessName"]').fill(name);
 await page.locator('#applicationForm [name="slug"]').fill(slug);
 await page.locator('#submitApplication').click();
 await expect(page.locator('#applicationProgress')).toContainText('等待總管理員審核');
}
test('PLATFORM_APPLICANT_ROOT_GRANTS — review applicant, grant features only, preserve merchant LINE ownership',async({page},info)=>{
 const h=await setup(page);try{
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  await expect(page.getByRole('button',{name:'新增商家管理員'})).toBeHidden();
  const submitted=await h.call({action:'platform.application.submit',businessName:'申請商家 A',slug:'merchant-a'},'manager');
  expect(submitted.status).toBe(200);
  await page.reload();
  await expect(page.locator('#applicationList .tenant-card')).toContainText('LINE 使用者 U');
  await page.getByRole('button',{name:'審核與選擇功能'}).click();
  await page.locator('[data-approve-feature="membership"]').check();
  await page.locator('[data-approve-feature="booking"]').check();
  await page.getByRole('button',{name:'審核通過'}).click();
  await expect(page.locator('#tenantList .tenant-card')).toContainText('申請商家 A');
  const before=(await h.db.query('select * from platform_private.tenants')).rows[0];
  expect(before.credentials_configured).toBe(false);
  await page.getByRole('button',{name:'調整開放功能'}).click();
  await expect(page.locator('#grantFeatures [data-grant-feature]')).toHaveCount(8);
  await page.locator('[data-grant-feature="booking"]').uncheck();
  await page.getByRole('button',{name:'儲存功能授權'}).click();
  await expect(page.locator('#grantDialog')).toBeHidden();
  const after=(await h.db.query('select * from platform_private.tenants')).rows[0];
  expect(after.features.membership).toBe(true);expect(after.features.booking).toBe(false);
  expect(after.line_config).toEqual(before.line_config);
  expect(after.credentials_configured).toBe(false);
  expect(after.status).toBe('pending_provisioning');expect(after.version).toBe(2);
  expect(h.errors).toEqual([]);
  await info.attach('platform-root-grants',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await h.db.close();}
});
test('ONBOARDING_GUIDE — exact LINE sources, saved checklist, responsible next step and no unusable links on mobile',async({page},info)=>{
 await page.setViewportSize({width:390,height:844});const h=await setup(page,'manager',{entry:'admin'});try{
  await submitMerchantApplication(page);
  await expect(page.locator('#onboardingJourney')).toContainText('送出申請');
  await expect(page.locator('#unifiedPortalNav [data-portal-entry="member"]')).toBeHidden();
  await expect(page.locator('#applicationNextStep')).toContainText('總管理員');
  const app=(await h.call({action:'platform.bootstrap'})).body.data.applications[0];
  const features=Object.fromEntries(Object.keys(h.tenant.features).map(k=>[k,['membership','booking'].includes(k)]));
  expect((await h.call({action:'platform.application.approve',applicationId:app.id,features,requestId:crypto.randomUUID()})).status).toBe(200);
  await page.locator('#refreshApplication').click();await expect(page.locator('#merchantWorkspace')).toBeVisible();
  await page.locator('#merchantSetupGuide summary').click();
  await expect(page.locator('#merchantSetupGuide')).toContainText('Basic settings');
  await expect(page.locator('#merchantSetupGuide')).toContainText('Endpoint URL');
  await expect(page.locator('#merchantSetupGuide')).toContainText('重新發行會讓原 token 失效');
  await expect(page.locator('#merchantLineForm [name="adminChannelId"]')).toHaveAttribute('aria-describedby','lineHelp-adminChannelId');
  await expect(page.locator('#merchantChecklist')).toContainText('尚缺：會員卡 LIFF ID');
  await page.locator('[data-setup-feature="booking"]').click();
  await expect(page.locator('#merchantLineSettingsPanel')).toBeVisible();
  await page.locator('#merchantLineForm [name="bookingLiffId"]').fill(h.tenant.line.bookingLiffId);
  await page.locator('#saveMerchantLine').click();
  await expect(page.locator('[data-merchant-panel="shared"]')).toBeVisible();
  await expect(page.locator('#merchantMessage')).toContainText('請先完成');
  for(const k of ['adminChannelId','memberChannelId','messagingChannelId','adminLiffId'])await page.locator('#merchantLineForm [name="'+k+'"]').fill(h.tenant.line[k]);
  for(const [k,v] of Object.entries(h.tenant.credentials))await page.locator('#merchantLineForm [name="'+k+'"]').fill(v);
  await page.locator('#saveMerchantLine').click();await expect(page.locator('#merchantMessage')).toContainText('已安全儲存');
  await page.locator('[data-line-feature="membership"]').click();
  await page.locator('#merchantLineForm [name="memberLiffId"]').fill(h.tenant.line.memberLiffId);
  await page.locator('#saveMerchantLine').click();await expect(page.locator('#merchantMessage')).toContainText('必填資料已齊全');
  await page.locator('#merchantOverviewTab').click();
  await expect(page.locator('#merchantLineSettingsPanel')).toBeHidden();
  await expect(page.locator('#merchantLaunchMessage')).toContainText('由平台');
  await expect(page.locator('[data-journey="verified"]')).toHaveAttribute('aria-current','step');
  await expect(page.getByRole('button',{name:'用戶端尚未開放',exact:true})).toBeDisabled();
  expect(await page.locator('#merchantLaunchStatus a').count()).toBe(0);
  await page.locator('#copySetupSummary').click();await expect(page.locator('#copySetupMessage')).toContainText('已複製');
  const copied=await page.evaluate(()=>navigator.clipboard.readText());
  expect(copied).toContain('尚未開放');expect(copied).not.toContain(h.tenant.credentials.channelAccessToken);expect(copied).not.toContain(h.tenant.credentials.channelSecret);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(h.errors).toEqual([]);
  await info.attach('onboarding-mobile',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await h.db.close();}
});
test('ONBOARDING_DRAFT — refresh preserves edited secrets; newer settings require explicit reload; revoked access discards draft',async({page})=>{
 const h=await setup(page,'manager',{entry:'admin'});try{
  await submitMerchantApplication(page);
  await expect(page.locator('#applicationProgress')).toBeVisible();
  const app=(await h.call({action:'platform.bootstrap'})).body.data.applications[0];
  const features=Object.fromEntries(Object.keys(h.tenant.features).map(k=>[k,k==='membership']));
  expect((await h.call({action:'platform.application.approve',applicationId:app.id,features,requestId:crypto.randomUUID()})).status).toBe(200);
  await page.locator('#refreshApplication').click();await expect(page.locator('#merchantWorkspace')).toBeVisible();
  await page.locator('#merchantLineSettingsTab').click();
  await expect(page.locator('#merchantLineSettingsPanel')).toBeVisible();
  await page.locator('#merchantLineForm [name="channelAccessToken"]').fill('unsaved-synthetic-token');
  const current=(await h.call({action:'platform.application.bootstrap'},'manager')).body.data.tenant;
  const saved=await h.call({action:'platform.line.save',requestId:crypto.randomUUID(),expectedVersion:current.version,line:{...h.tenant.line,pointsLiffId:'',eventLiffId:'',calendarLiffId:'',bookingLiffId:''},credentials:h.tenant.credentials},'manager');
  expect(saved.status).toBe(200);
  await page.locator('#refreshApplication').click();await expect(page.locator('#reloadMerchantSettings')).toBeVisible();
  await expect(page.locator('#merchantLineForm [name="channelAccessToken"]')).toHaveValue('unsaved-synthetic-token');
  await page.locator('#reloadMerchantSettings').click();
  await expect(page.locator('#merchantLineForm [name="channelAccessToken"]')).toHaveValue('');
  await page.locator('#merchantLineForm [name="channelAccessToken"]').fill('another-unsaved-synthetic-token');
  expect((await h.call({action:'platform.tenant.suspend',tenantId:current.id,expectedVersion:saved.body.data.tenant.version,requestId:crypto.randomUUID()})).status).toBe(200);
  await page.locator('#refreshApplication').click();await expect(page.locator('#merchantWorkspace')).toBeHidden();
  await expect(page.locator('#merchantLineForm [name="channelAccessToken"]')).toHaveValue('');
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('ONBOARDING_LINE_RETRY — lost save response locks draft and replays the exact request once',async({page})=>{
 const h=await setup(page,'manager',{entry:'admin',loseFirstLineSave:true});try{
  await submitMerchantApplication(page);
  await expect(page.locator('#applicationProgress')).toBeVisible();
  const app=(await h.call({action:'platform.bootstrap'})).body.data.applications[0];
  const features=Object.fromEntries(Object.keys(h.tenant.features).map(k=>[k,k==='membership']));
  expect((await h.call({action:'platform.application.approve',applicationId:app.id,features,requestId:crypto.randomUUID()})).status).toBe(200);
  await page.locator('#refreshApplication').click();await expect(page.locator('#merchantWorkspace')).toBeVisible();
  await page.locator('#merchantLineSettingsTab').click();
  await expect(page.locator('#merchantLineSettingsPanel')).toBeVisible();
  for(const k of ['adminChannelId','memberChannelId','messagingChannelId','adminLiffId'])await page.locator('#merchantLineForm [name="'+k+'"]').fill(h.tenant.line[k]);
  for(const [k,v] of Object.entries(h.tenant.credentials))await page.locator('#merchantLineForm [name="'+k+'"]').fill(v);
  await page.locator('#saveMerchantLine').click();await expect(page.locator('#merchantMessage')).toContainText('尚未確認');
  await expect(page.locator('#merchantLineForm [name="adminChannelId"]')).toBeDisabled();
  await expect(page.locator('[data-line-feature="membership"]')).toBeDisabled();
  await page.getByRole('button',{name:'重試相同儲存操作'}).click();await expect(page.locator('#merchantMessage')).toContainText('已安全儲存');
  expect((await h.db.query('select version from platform_private.tenants')).rows[0].version).toBe(2);
  expect((await h.db.query("select count(*)::int n from platform_private.audit_events where action='MERCHANT_LINE_UPDATED'")).rows[0].n).toBe(1);
  await expect(page.locator('#merchantLineForm [name="channelAccessToken"]')).toHaveValue('');expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_RETRY — lost root grant response reuses request id without double updates',async({page})=>{
 const h=await setup(page,'root',{loseFirstSave:true});try{
  await h.call({action:'platform.application.submit',businessName:'重試商家',slug:'retry-shop'},'manager');
  const app=(await h.call({action:'platform.bootstrap'})).body.data.applications[0];
  expect((await h.call({action:'platform.application.approve',applicationId:app.id,features:h.tenant.features,requestId:crypto.randomUUID()})).status).toBe(200);
  await page.reload();
  await page.getByRole('button',{name:'調整開放功能'}).click();
  await page.locator('[data-grant-feature="booking"]').uncheck();
  await page.getByRole('button',{name:'儲存功能授權'}).click();
  await expect(page.locator('#grantMessage')).toContainText('尚未確認');
  await page.getByRole('button',{name:'儲存功能授權'}).click();
  await expect(page.locator('#grantDialog')).toBeHidden();
  expect((await h.db.query("select count(*)::int n from platform_private.audit_events where action='TENANT_FEATURES_UPDATED'")).rows[0].n).toBe(1);
  expect((await h.db.query('select version from platform_private.tenants')).rows[0].version).toBe(2);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_APPLY — admin entry reads status without applying; explicit submission is persisted once',async({page})=>{
 const h=await setup(page,'manager',{entry:'admin'});try{
  await expect(page).toHaveURL(/\/admin\/?(?:\?.*)?$/);
  await expect(page.locator('#productizedAdmin')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  expect(await page.evaluate(()=>document.title)).toBe('管理端｜Lumen Club');
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await expect(page.locator('#applicationForm')).toBeVisible();
  await expect(page.locator('#applicationProgress')).toBeHidden();
  await expect(page.locator('#merchantWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>window.initializedLiffId)).toBe('2010791619-admin');
  expect((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n).toBe(0);
  await page.reload();
  await expect(page.locator('#applicationForm')).toBeVisible();
  expect((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n).toBe(0);
  await submitMerchantApplication(page,'手動送審商家','manual-review-shop');
  await expect(page.locator('#applicationForm')).toBeHidden();
  await page.reload();
  await expect(page.locator('#applicationProgress')).toContainText('等待總管理員審核');
  expect((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n).toBe(1);
  expect((await h.db.query("select count(*)::int n from platform_private.audit_events where action='APPLICATION_SUBMITTED'")).rows[0].n).toBe(1);
  expect((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n).toBe(0);
  expect(h.providerCalls.every(call=>call.channel==='2010791619')).toBe(true);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('ADMIN_STALE_BUSINESS — missing merchant entry returns to unscoped LINE admin without cross-tenant access',async({page})=>{
 const h=await setup(page,'manager',{entry:'admin'});try{
  await expect(page.locator('#applicationForm')).toBeVisible();
  await page.goto(base+'/admin/?business=missing-merchant&feature=membership');
  await expect(page).toHaveURL(base+'/admin/?feature=membership');
  await expect(page.locator('#applicationForm')).toBeVisible();
  await expect(page.locator('#merchantWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>window.initializedLiffId)).toBe('2010791619-admin');
  expect((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n).toBe(0);
  expect((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n).toBe(0);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('ADMIN_INCLIENT_UNAUTH — signed-out LIFF browser retries initialization once without a login button or loop',async({page})=>{
 const h=await setup(page,'manager',{entry:'admin',inClient:true,loggedIn:false});try{
  await expect(page.locator('#platformStatus')).toContainText('LINE 登入未完成');
  await expect(page.locator('#applicationWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>sessionStorage.getItem('admin-line-auto-attempt-v1'))).not.toBeNull();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  expect(h.providerCalls).toEqual([]);
  expect((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n).toBe(0);
  await page.reload();
  await expect(page.locator('#platformStatus')).toContainText('LINE 登入未完成');
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('ADMIN_INCLIENT_RECOVERY — automatic LIFF reinit restores login without manual buttons or duplicate applications',async({page})=>{
 await page.addInitScript(()=>{
  if(sessionStorage.getItem('admin-line-auto-attempt-v1'))sessionStorage.setItem('qaLoggedIn','1');
 });
 const h=await setup(page,'manager',{entry:'admin',inClient:true,loggedIn:false});try{
  await expect(page.locator('#applicationForm')).toBeVisible();
  await expect(page.locator('#applicationProgress')).toBeHidden();
  expect(await page.evaluate(()=>window.initializedLiffId)).toBe('2010791619-admin');
  expect(await page.evaluate(()=>sessionStorage.getItem('admin-line-auto-attempt-v1'))).toBeNull();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  expect(h.providerCalls.length).toBeGreaterThan(0);
  expect((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n).toBe(0);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('ADMIN_EXTERNAL_UNAUTH — external visitor launches LINE login, callback authenticates without auto-submitting review',async({page})=>{
 const h=await setup(page,'manager',{entry:'admin',inClient:false,loggedIn:false});try{
  await expect.poll(()=>page.evaluate(()=>window.loginCalls)).toEqual([[]]);
  await expect(page.locator('#applicationForm')).toBeHidden();
  expect((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n).toBe(0);
  await page.evaluate(()=>sessionStorage.setItem('qaLoggedIn','1'));
  await page.reload();
  await expect(page.locator('#applicationForm')).toBeVisible();
  expect(await page.evaluate(()=>window.initializedLiffId)).toBe('2010791619-admin');
  expect(await page.evaluate(()=>sessionStorage.getItem('admin-line-auto-attempt-v1'))).toBeNull();
  expect((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n).toBe(0);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('ADMIN_EXTERNAL_CALLBACK_FAILED — rejected or missing session stops without repeated redirects',async({page})=>{
 const h=await setup(page,'manager',{entry:'admin',inClient:false,loggedIn:false});try{
  await expect.poll(()=>page.evaluate(()=>window.loginCalls)).toEqual([[]]);
  await page.reload();
  await expect(page.locator('#platformStatus')).toContainText('LINE 登入未完成');
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  await page.reload();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  expect((await h.db.query('select count(*)::int n from platform_private.applications')).rows[0].n).toBe(0);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_MANAGER_SETUP — approved admin can configure own LINE but cannot edit feature grants',async({page})=>{
 const h=await setup(page,'manager',{entry:'admin'});try{
  await submitMerchantApplication(page);
  await expect(page.locator('#applicationProgress')).toContainText('等待總管理員審核');
  const app=(await h.call({action:'platform.bootstrap'})).body.data.applications[0];
  const features=Object.fromEntries(Object.keys(h.tenant.features).map(k=>[k,k==='membership']));
  const result=await h.call({action:'platform.application.approve',applicationId:app.id,features,requestId:crypto.randomUUID()});
  expect(result.status).toBe(200);
  await page.getByRole('button',{name:'重新檢查申請與功能權限'}).click();await expect(page.locator('#merchantWorkspace')).toBeVisible();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await expect(page.locator('#merchantFeatures')).toContainText('會員卡');
  await expect(page.locator('#merchantFeatures')).not.toContainText('預約');
  await expect(page.locator('#merchantOverviewPanel')).toBeVisible();
  await page.locator('#merchantLineSettingsTab').click();
  await expect(page.locator('#merchantLineSettingsPanel')).toBeVisible();
  await expect(page.locator('#merchantFeatureNav [data-line-feature]')).toHaveCount(2);
  await expect(page.locator('#merchantFeatureNav [data-line-feature="booking"]')).toHaveCount(0);
  await expect(page.locator('#merchantFeatureNav [data-line-feature="events"]')).toHaveCount(0);
  await expect(page.locator('#merchantFeatureNav')).toBeVisible();
  await expect(page.locator('#adminView .surface-nav')).toBeHidden();
  for(const k of ['adminChannelId','memberChannelId','messagingChannelId','adminLiffId'])
    await page.locator('#merchantLineForm [name="'+k+'"]').fill(h.tenant.line[k]);
  for(const [k,v] of Object.entries(h.tenant.credentials))
    await page.locator('#merchantLineForm [name="'+k+'"]').fill(v);
  await page.getByRole('button',{name:'儲存此頁 LINE 設定'}).click();
  await expect(page.locator('#merchantMessage')).toContainText('已安全儲存');
  let partial=(await h.db.query("select line_config from platform_private.tenants ")).rows[0];
  expect(partial.line_config.memberLiffId).toBe('');
  await page.locator('#merchantFeatureNav [data-line-feature="membership"]').click();
  await expect(page.locator('[data-merchant-panel="membership"]')).toBeVisible();
  await page.locator('#merchantLineForm [name="memberLiffId"]').fill(h.tenant.line.memberLiffId);
  await page.getByRole('button',{name:'儲存此頁 LINE 設定'}).click();
  await expect(page.locator('#merchantMessage')).toContainText('已安全儲存');
  await page.reload();
  await expect(page.locator('#merchantFeatureNav [data-line-feature="booking"]')).toHaveCount(0);
  const tenant=(await h.db.query('select features,credentials_configured,status,owner_line_user_id from platform_private.tenants where id=$1',[result.body.data.tenant.id])).rows[0];
  expect(tenant).toBeDefined();
  expect(tenant.owner_line_user_id).toBe(app.applicantLineUserId);
  expect(tenant.features.booking).toBe(false);
  expect(tenant.credentials_configured).toBe(true);
  expect(tenant.status).toBe('pending_provisioning');
  await expect(page.locator('#merchantLineForm [name="memberLiffId"]')).toHaveValue(h.tenant.line.memberLiffId);
  const current=(await h.call({action:'platform.application.bootstrap'},'manager')).body.data.tenant;
  const reduced=await h.call({action:'platform.tenant.features.save',tenantId:current.id,expectedVersion:current.version,requestId:crypto.randomUUID(),features:{...current.features,membership:false,booking:true}});
  expect(reduced.status).toBe(200);
  await page.getByRole('button',{name:'重新檢查申請與功能權限'}).click();
  await expect(page.locator('#merchantFeatureNav [data-line-feature="membership"]')).toHaveCount(0);
  await expect(page.locator('#merchantFeatureNav [data-line-feature="booking"]')).toHaveCount(1);
  const suspended=await h.call({action:'platform.tenant.suspend',tenantId:current.id,expectedVersion:reduced.body.data.tenant.version,requestId:crypto.randomUUID()});
  expect(suspended.status).toBe(200);
  await page.getByRole('button',{name:'重新檢查申請與功能權限'}).click();
  await expect(page.locator('#merchantWorkspace')).toBeHidden();
  await expect(page.locator('#applicationProgress')).toContainText('停用');
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_REVIEW — root checks requested grants and approves pending admin in UI',async({page})=>{
 const h=await setup(page);try{
  const submitted=await h.call({action:'platform.application.submit',businessName:'待審核商家',slug:'new-review'},'manager');
  expect(submitted.status).toBe(200);
  await page.reload();
  await expect(page.locator('#applicationList .tenant-card')).toHaveCount(1);
  await page.getByRole('button',{name:'審核與選擇功能'}).click();
  await expect(page.locator('#approvalFeatures [data-approve-feature]')).toHaveCount(8);
  await page.locator('[data-approve-feature="booking"]').check();
  await page.getByRole('button',{name:'審核通過'}).click();
  await expect(page.locator('#approvalDialog')).toBeHidden();
  await expect(page.locator('#applicationList .tenant-card')).toHaveCount(0);
  await expect(page.locator('#tenantList .tenant-card')).toHaveCount(1);
  const tenant=(await h.db.query("select features,status from platform_private.tenants where slug='new-review'")).rows[0];
  expect(tenant.features.booking).toBe(true);
  expect(tenant.features.membership).toBe(false);
  expect(tenant.status).toBe('pending_provisioning');
 }finally{await h.db.close();}
});
test('PLATFORM_CHANNEL_DENIED — root identity using the old admin channel is rejected',async({page})=>{
 const h=await setup(page,'legacy-root');try{await expect(page.locator('#platformStatus')).toContainText('LINE 身分驗證未通過');await expect(page.locator('#platformWorkspace')).toBeHidden();expect(h.errors).toEqual([]);}finally{await h.db.close();}
});
test('PLATFORM_CONFIG_REQUIRED — missing platform LIFF never falls back to merchant admin login',async({page})=>{
 const h=await setup(page,'root',{platformLiffId:''});try{await expect(page.locator('#platformStatus')).toContainText('總管理員專用 LIFF');await expect(page.locator('#platformWorkspace')).toBeHidden();expect(await page.evaluate(()=>window.initializedLiffId)).toBeUndefined();expect(h.providerCalls).toEqual([]);expect(h.errors).toEqual([]);}finally{await h.db.close();}
});
test('PLATFORM_EXTERNAL_LOGIN — external browser uses the configured LIFF endpoint without custom redirect query',async({page})=>{
 // A first login cannot already have a successful callback marker.
 const h=await setup(page,'root',{inClient:false,loggedIn:false,rootLoginReturn:false});try{
  await expect(page.locator('#platformStatus')).toContainText('正在前往 LINE 登入');
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([[]]);
  expect(new URL(page.url()).searchParams.has('member_system_reauth')).toBe(false);
  expect(h.providerCalls).toEqual([]);await expect(page.locator('#platformWorkspace')).toBeHidden();expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_EXTERNAL_RETURN — valid external LINE session loads the root workspace without a redirect loop',async({page})=>{
 const h=await setup(page,'root',{inClient:false,loggedIn:true});try{
  await expect(page.locator('#platformWorkspace')).toBeVisible();expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  expect(h.providerCalls.length).toBeGreaterThan(0);expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_MOBILE — applicant identity and approved grant panel stay safe on narrow screens',async({page},info)=>{
 await page.setViewportSize({width:390,height:844});const h=await setup(page);try{
  const name='<img src=x onerror=alert(1)>';
  await h.call({action:'platform.application.submit',businessName:name,slug:'safe-mobile'},'manager');
  await page.reload();
  await expect(page.locator('#applicationList .tenant-card h3')).toHaveText(name);
  expect(await page.locator('#applicationList .tenant-card img').count()).toBe(0);
  await page.getByRole('button',{name:'審核與選擇功能'}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await info.attach('platform-mobile-grants',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_ROOT_REAUTH — every Platform visit and BFCache restore automatically re-verifies LINE',async({page})=>{
 const h=await setup(page,'root',{rootLoginReturn:false,inClient:true});try{
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  await expect(page.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  expect(await page.evaluate(()=>sessionStorage.getItem('qaRootLogoutCount'))).toBe('1');
  expect(await page.evaluate(()=>sessionStorage.getItem('platform-line-login-return-v1'))).toBeNull();
  expect(await page.evaluate(()=>sessionStorage.getItem('platform-line-auto-attempt-v1'))).toBeNull();
  await page.reload();
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('qaRootLogoutCount'))).toBe('2');
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  // The BFCache event intentionally navigates; wait for the reauthenticated UI
  // before reading sessionStorage from the new browsing context.
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  expect(await page.evaluate(()=>sessionStorage.getItem('qaRootLogoutCount'))).toBe('3');
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_ROOT_EXTERNAL_REAUTH — external LINE authentication starts automatically on each visit',async({page})=>{
 const h=await setup(page,'root',{rootLoginReturn:false,inClient:false,loggedIn:true});try{
  await expect.poll(()=>page.evaluate(()=>window.loginCalls)).toEqual([[]]);
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>window.logoutCalls)).toBe(1);
  await page.reload(); // LINE callback with its one-use return marker
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  await expect(page.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  await page.reload(); // A new visit must reauthenticate without any extra click.
  await expect.poll(()=>page.evaluate(()=>window.loginCalls)).toEqual([[]]);
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await page.reload(); // Next LINE callback
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_BAD_TOKEN_RECOVERY — wrong-channel LINE token never exposes workspace or causes login loop',async({page})=>{
 const h=await setup(page,'legacy-root',{rootLoginReturn:false});try{
  await expect(page.locator('#platformStatus')).toContainText('LINE 身分驗證未通過');
  await expect(page.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>sessionStorage.getItem('qaRootLogoutCount'))).toBe('1');
  await page.reload();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>sessionStorage.getItem('qaRootLogoutCount'))).toBe('1');
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  expect(await page.evaluate(()=>sessionStorage.getItem('platform-line-login-return-v1'))).toBeNull();
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_EXTERNAL_FIRST_SIGNIN — signed-out entry and subsequent visits automatically launch LINE',async({page})=>{
 const h=await setup(page,'root',{inClient:false,loggedIn:false,rootLoginReturn:false});try{
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([[]]);
  expect(await page.evaluate(()=>sessionStorage.getItem('platform-line-login-return-v1'))).not.toBeNull();
  await page.evaluate(()=>sessionStorage.setItem('qaLoggedIn','1'));
  await page.reload();
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  await expect(page.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>window.loginCalls)).toEqual([[]]);
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await page.reload();
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_EXTERNAL_CALLBACK_FAILED — failed callback is rejected without repeated login redirects or extra UI',async({page})=>{
 const h=await setup(page,'root',{inClient:false,loggedIn:false,rootLoginReturn:false});try{
  await expect.poll(()=>page.evaluate(()=>window.loginCalls)).toEqual([[]]);
  expect(await page.evaluate(()=>sessionStorage.getItem('platform-line-login-return-v1'))).not.toBeNull();
  await page.reload(); // LINE returned without a signed-in session.
  await expect(page.locator('#platformStatus')).toContainText('LINE 登入未完成');
  await expect(page.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  await page.reload();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_EXPIRED_RETURN — expired callback cannot trigger redirects or root access',async({page})=>{
 await page.addInitScript(()=>sessionStorage.setItem('platform-line-login-return-v1',String(Date.now()-181000)));
 const h=await setup(page,'root',{rootLoginReturn:false,inClient:false,loggedIn:true});try{
  await expect(page.locator('#platformStatus')).toContainText('回跳已過期');
  await expect(page.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  expect(await page.evaluate(()=>sessionStorage.getItem('platform-line-login-return-v1'))).toBeNull();
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_INCLIENT_UNAUTH — signed-out in-client LIFF retries automatically at most once, without a login card',async({page})=>{
 const h=await setup(page,'root',{inClient:true,loggedIn:false,rootLoginReturn:false});try{
  await expect(page.locator('#platformStatus')).toContainText('LINE 登入未完成');
  await expect(page.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>sessionStorage.getItem('qaRootLogoutCount'))).toBe('1');
  await page.reload();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>sessionStorage.getItem('qaRootLogoutCount'))).toBe('1');
  expect(h.providerCalls).toEqual([]);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_UNIFIED_PORTALS — navigation never bypasses per-role authentication',async({page})=>{
 const h=await setup(page);try{
  const nav=page.locator('#unifiedPortalNav');
  await expect(nav).toHaveCount(0);
  // The root workspace has no link to merchant or client entrances.
  await expect(page.locator('a[href^="/admin/"],a[href^="../admin/"],a[href^="/member/"]')).toHaveCount(0);
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});

test('PLATFORM_ROOT_UNAPPROVED — verified but unapproved LINE displays only pending text until DBA grants access',async({page})=>{
 const h=await setup(page,'root',{manualGrant:false});try{
  const notice=page.locator('#platformAuthorizationNotice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText('總管理員權限尚未核准');
  for(const id of ['#platformHeader','#platformStatus','#platformWorkspace'])await expect(page.locator(id)).toBeHidden();
  await expect(page.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  await page.reload();
  await expect(notice).toHaveText('總管理員權限尚未核准');
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  // Only a privileged change to the isolated test database can grant access.
  await h.db.exec('update platform_private.super_admins set enabled=true where singleton');
  await page.reload(); // No manual LINE login button; reauthenticate on page entry.
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  await expect(notice).toBeHidden();
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_UNMATCHED_ROOT — an unbound LINE identity sees only pending status, never an automatic grant',async({page})=>{
 const h=await setup(page,'manager');try{
  await expect(page.locator('#platformAuthorizationNotice')).toHaveText('總管理員權限尚未核准');
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await expect(page.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  expect((await h.db.query('select enabled from platform_private.super_admins where singleton')).rows[0].enabled).toBe(true);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_ADMIN_TOP_GRANTS — Lumen header exposes only server-approved modules, rejects forged feature links',async({page})=>{
 const h=await setup(page,'manager',{entry:'admin'});try{
  await submitMerchantApplication(page);
  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(page.locator('#applicationProgress')).toContainText('等待總管理員審核');
  await expect(page.locator('#merchantFeatureNav')).toBeHidden();
  await expect(page.locator('#app')).toBeHidden();
  const application=(await h.call({action:'platform.bootstrap'})).body.data.applications[0];
  const allowed=Object.fromEntries(Object.keys(h.tenant.features).map(k=>[k,k==='membership'||k==='points']));
  const grant=await h.call({action:'platform.application.approve',applicationId:application.id,features:allowed,requestId:crypto.randomUUID()});
  expect(grant.status).toBe(200);
  await page.getByRole('button',{name:'重新檢查申請與功能權限'}).click();
  await expect(page.locator('#merchantLineSettingsTab')).toBeVisible();
  await page.locator('#merchantLineSettingsTab').click();
  await expect(page.locator('#merchantLineSettingsPanel')).toBeVisible();
  await expect(page.locator('#merchantFeatureNav [data-line-feature]')).toHaveCount(3);
  await expect(page.locator('#merchantFeatureNav [data-line-feature="membership"]')).toBeVisible();
  await expect(page.locator('#merchantFeatureNav [data-line-feature="points"]')).toBeVisible();
  await expect(page.locator('#merchantFeatureNav [data-line-feature="booking"]')).toHaveCount(0);
  await expect(page.locator('#merchantFeatureNav [data-line-feature="testing"]')).toHaveCount(0);
  await page.goto(base+'/admin/?feature=booking');
  await expect(page.locator('#merchantLineSettingsTab')).toBeVisible();
  await page.locator('#merchantLineSettingsTab').click();
  await expect(page.locator('#merchantFeatureNav')).toBeVisible();
  await expect(page.locator('#merchantFeatureNav [data-line-feature="booking"]')).toHaveCount(0);
  await expect(page.locator('#merchantFeatureNav [data-line-feature="shared"]')).toHaveAttribute('aria-current','page');
  const before=await h.call({action:'platform.application.bootstrap'},'manager');
  expect(before.body.data.tenant.status).toBe('pending_provisioning');
  const change=await h.call({action:'platform.tenant.features.save',tenantId:grant.body.data.tenant.id,
    expectedVersion:before.body.data.tenant.version,features:{...allowed,membership:false,points:false,events:true},
    requestId:crypto.randomUUID()});
  expect(change.status).toBe(200);
  await page.getByRole('button',{name:'重新檢查申請與功能權限'}).click();
  await expect(page.locator('#merchantFeatureNav [data-line-feature="membership"]')).toHaveCount(0);
  await expect(page.locator('#merchantFeatureNav [data-line-feature="points"]')).toHaveCount(0);
  await expect(page.locator('#merchantFeatureNav [data-line-feature="events"]')).toBeVisible();
  // Disabling everything still provides only shared configuration, not business modules.
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
