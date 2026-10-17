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
async function setup(page,token='root',{loseFirstSave=false,platformLiffId='2012065297-VunxFBj8',inClient=true,loggedIn=true,rootLoginReturn=true}={}) {
 const h=await fixture();h.allowedOrigins.add(base);let lost=false;const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 if(rootLoginReturn&&token==='root')await page.addInitScript(()=>{
  // Simulate a genuine LINE return for the pre-existing root-control cases.
  sessionStorage.setItem('platform-line-login-return-v1',String(Date.now()));
 });
 await page.route('**/config.json',route=>route.fulfill({json:{brandName:'QA Platform',supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'sb_publishable_fixture',adminLiffId:'2010791619-admin',platformLiffId}}));
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:`window.loginCalls=[];window.logoutCalls=0;window.liff={init:async options=>{window.initializedLiffId=options.liffId;},isInClient:()=>${inClient},isLoggedIn:()=>${loggedIn}||sessionStorage.getItem('qaLoggedIn')==='1',login:(...args)=>{window.loginCalls.push(args);},logout:()=>{window.logoutCalls+=1;sessionStorage.setItem('qaRootLogoutCount',String(Number(sessionStorage.getItem('qaRootLogoutCount')||'0')+1));},getIDToken:()=>${JSON.stringify(token)}};`}));
 await page.route('https://fixture.supabase.co/functions/v1/platform-api',async route=>{
  const method=route.request().method();
  const input=method==='POST'?route.request().postDataJSON():null;
  const headers=new Headers(route.request().headers());headers.set('Origin',base);
  const response=await h.handler(new Request(route.request().url(),{method,headers,...(method==='POST'?{body:JSON.stringify(input)}:{})}));
  if(loseFirstSave&&!lost&&input?.action==='platform.tenant.save'){lost=true;return route.abort('failed');}
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
 });
 await page.goto(base+'/platform/');return {...h,errors};
}
async function fillNew(page,tenant) {
 await page.getByRole('button',{name:'新增商家管理員'}).click();
 for(const key of ['name','slug','ownerLineUserId'])await page.locator(`#tenantForm [name="${key}"]`).fill(tenant[key]);
 for(const [key,value] of Object.entries(tenant.line))await page.locator(`#tenantForm [name="${key}"]`).fill(value);
 for(const [key,value] of Object.entries(tenant.credentials))await page.locator(`#tenantForm [name="${key}"]`).fill(value);
 for(const key of ['membership','points','booking'])await page.locator(`[data-feature="${key}"]`).check();
}
test('PLATFORM_CREATE_EDIT — root saves merchant, eight grants and encrypted LINE credentials through real handler + SQL',async({page},info)=>{
 const h=await setup(page);try{
  await expect(page.locator('#platformWorkspace')).toBeVisible();expect(await page.evaluate(()=>window.initializedLiffId)).toBe('2012065297-VunxFBj8');expect(h.providerCalls.every(call=>call.channel==='2012065297')).toBe(true);await fillNew(page,h.tenant);
  await expect(page.locator('#tenantForm [name="channelAccessToken"]')).toHaveAttribute('type','password');await expect(page.locator('[data-feature]')).toHaveCount(8);
  await page.getByRole('button',{name:'儲存商家設定',exact:true}).click();await expect(page.locator('#tenantDialog')).toBeHidden();await expect(page.locator('.tenant-card')).toHaveCount(1);await expect(page.locator('.tenant-card')).toContainText('待佈建');
  let row=(await h.db.query('select * from platform_private.tenants')).rows[0];expect(row.features.booking).toBe(true);expect(row.features.testing).toBe(false);
  const before=(await h.db.query('select envelope from platform_private.tenant_secrets')).rows[0].envelope;
  await page.getByRole('button',{name:'編輯設定'}).click();await expect(page.locator('#tenantForm [name="channelAccessToken"]')).toHaveValue('');await expect(page.locator('#tenantForm [name="channelSecret"]')).toHaveValue('');
  await page.locator('#tenantForm [data-feature="booking"]').uncheck();await page.locator('#tenantForm [name="name"]').fill('商家 A 更新');await page.getByRole('button',{name:'儲存商家設定',exact:true}).click();await expect(page.locator('#tenantDialog')).toBeHidden();await expect(page.locator('.tenant-card')).toContainText('商家 A 更新');
  row=(await h.db.query('select * from platform_private.tenants')).rows[0];expect(row.version).toBe(2);expect(row.features.booking).toBe(false);expect((await h.db.query('select envelope from platform_private.tenant_secrets')).rows[0].envelope).toEqual(before);
  await page.getByRole('button',{name:'停用商家'}).click();await expect(page.locator('.tenant-card')).toContainText('已停用');expect((await h.db.query('select status from platform_private.tenants')).rows[0].status).toBe('suspended');expect(h.errors).toEqual([]);
  await info.attach('platform-control',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await h.db.close();}
});
test('PLATFORM_RETRY — response lost after commit retries the same request without duplicate merchant or audit',async({page})=>{
 const h=await setup(page,'root',{loseFirstSave:true});try{
  await expect(page.locator('#platformWorkspace')).toBeVisible();await fillNew(page,h.tenant);await page.getByRole('button',{name:'儲存商家設定',exact:true}).click();await expect(page.getByRole('button',{name:'重試相同儲存操作'})).toBeEnabled();await expect(page.locator('[name="name"]')).toBeDisabled();
  await page.getByRole('button',{name:'重試相同儲存操作'}).click();await expect(page.locator('#tenantDialog')).toBeHidden();expect((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n).toBe(1);expect((await h.db.query('select count(*)::int n from platform_private.audit_events')).rows[0].n).toBe(1);expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_APPLY — ordinary admin sees application form but never root controls',async({page})=>{
 const h=await setup(page,'manager');try{
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await expect(page.locator('#applicationWorkspace')).toBeVisible();
  await page.locator('#applicationForm [name="businessName"]').fill('商家申請 B');
  await page.locator('#applicationForm [name="slug"]').fill('merchant-b');
  await page.getByRole('button',{name:'提交審核申請'}).click();
  await expect(page.locator('#applicationProgress')).toContainText('等待總管理員審核');
  await expect(page.locator('#applicationForm')).toBeHidden();
  await expect(page.locator('#merchantWorkspace')).toBeHidden();
  expect((await h.db.query('select count(*)::int n from platform_private.tenants')).rows[0].n).toBe(0);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_MANAGER_SETUP — approved admin can configure own LINE but cannot edit feature grants',async({page})=>{
 const h=await setup(page,'manager');try{
  await h.call({action:'platform.application.submit',businessName:'LINE 自助設定',slug:'self-service-b'},'manager');
  const app=(await h.call({action:'platform.bootstrap'})).body.data.applications[0];
  const features=Object.fromEntries(Object.keys(h.tenant.features).map(k=>[k,k==='membership']));
  const result=await h.call({action:'platform.application.approve',applicationId:app.id,features,requestId:crypto.randomUUID()});
  expect(result.status).toBe(200);
  await page.reload();await expect(page.locator('#merchantWorkspace')).toBeVisible();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await expect(page.locator('#merchantFeatures')).toContainText('會員卡');
  await expect(page.locator('#merchantFeatures')).not.toContainText('預約');
  for(const [k,v] of Object.entries(h.tenant.line))await page.locator('#merchantLineForm [name="'+k+'"]').fill(v);
  for(const [k,v] of Object.entries(h.tenant.credentials))await page.locator('#merchantLineForm [name="'+k+'"]').fill(v);
  await page.getByRole('button',{name:'儲存我的 LINE 設定'}).click();
  await expect(page.locator('#merchantMessage')).toContainText('已安全儲存');
  const tenant=(await h.db.query('select features,credentials_configured,status from platform_private.tenants where slug=$1',['self-service-b'])).rows[0];
  expect(tenant.features.booking).toBe(false);
  expect(tenant.credentials_configured).toBe(true);
  expect(tenant.status).toBe('pending_provisioning');
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
 const h=await setup(page,'root',{inClient:false,loggedIn:false});try{
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
test('PLATFORM_MOBILE — merchant form fits narrow screen and renders merchant names as text',async({page},info)=>{
 await page.setViewportSize({width:390,height:844});const h=await setup(page);try{
  await expect(page.locator('#platformWorkspace')).toBeVisible();await fillNew(page,{...h.tenant,name:'<img src=x onerror=alert(1)>'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await info.attach('platform-mobile-form',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
  await page.getByRole('button',{name:'儲存商家設定',exact:true}).click();await expect(page.locator('#tenantDialog')).toBeHidden();await expect(page.locator('.tenant-card h3')).toHaveText('<img src=x onerror=alert(1)>');expect(await page.locator('.tenant-card img').count()).toBe(0);expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});

test('PLATFORM_ROOT_REAUTH — every fresh root visit requires LINE re-login, return is one-use, BFCache is blocked',async({page})=>{
 const h=await setup(page,'root',{rootLoginReturn:false,inClient:true});try{
  await expect(page.locator('#platformLoginGate')).toBeVisible();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(h.providerCalls.length).toBeGreaterThan(0); // recognizes root, never grants the workspace yet
  await page.getByRole('button',{name:'重新使用 LINE 登入'}).click();
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  await expect(page.locator('#platformLoginGate')).toBeHidden();
  expect(await page.evaluate(()=>sessionStorage.getItem('qaRootLogoutCount'))).toBe('1');
  expect(await page.evaluate(()=>sessionStorage.getItem('platform-line-login-return-v1'))).toBeNull();
  await page.reload();
  await expect(page.locator('#platformLoginGate')).toBeVisible();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await page.getByRole('button',{name:'重新使用 LINE 登入'}).click();
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  expect(await page.evaluate(()=>sessionStorage.getItem('qaRootLogoutCount'))).toBe('2');
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await expect(page.locator('#platformLoginGate')).toBeVisible();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_ROOT_EXTERNAL_REAUTH — external browser logs out before LINE login and never loops on callback',async({page})=>{
 const h=await setup(page,'root',{rootLoginReturn:false,inClient:false,loggedIn:true});try{
  await expect(page.locator('#platformLoginGate')).toBeVisible();
  await page.getByRole('button',{name:'重新使用 LINE 登入'}).click();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([[]]);
  expect(await page.evaluate(()=>window.logoutCalls)).toBe(1);
  await page.reload(); // Simulated LINE SDK callback with a fresh token
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  await expect(page.locator('#platformLoginGate')).toBeHidden();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  await page.reload();
  await expect(page.locator('#platformLoginGate')).toBeVisible();
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_BAD_TOKEN_RECOVERY — wrong-channel token offers retry but never opens super admin or creates an infinite loop',async({page})=>{
 const h=await setup(page,'legacy-root',{rootLoginReturn:false});try{
  await expect(page.locator('#platformLoginGate')).toBeVisible();
  await expect(page.locator('#platformStatus')).toContainText('LINE 身分驗證未通過');
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await page.getByRole('button',{name:'重新使用 LINE 登入'}).click();
  await expect(page.locator('#platformLoginGate')).toBeVisible();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>sessionStorage.getItem('qaRootLogoutCount'))).toBe('1');
  expect(await page.evaluate(()=>sessionStorage.getItem('platform-line-login-return-v1'))).toBeNull();
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});

test('PLATFORM_EXTERNAL_FIRST_SIGNIN — first signed-out external login returns directly to the root without a second login',async({page})=>{
 const h=await setup(page,'root',{inClient:false,loggedIn:false,rootLoginReturn:false});try{
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([[]]);
  expect(await page.evaluate(()=>sessionStorage.getItem('platform-line-login-return-v1'))).not.toBeNull();
  await page.evaluate(()=>sessionStorage.setItem('qaLoggedIn','1'));
  await page.reload();
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  await expect(page.locator('#platformLoginGate')).toBeHidden();
  expect(await page.evaluate(()=>window.loginCalls)).toEqual([]);
  await page.reload();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  await expect(page.locator('#platformLoginGate')).toBeVisible();
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
test('PLATFORM_INCLIENT_UNAUTH — missing LINE login shows recovery instead of a dead end',async({page})=>{
 const h=await setup(page,'root',{inClient:true,loggedIn:false,rootLoginReturn:false});try{
  await expect(page.locator('#platformLoginGate')).toBeVisible();
  await expect(page.locator('#platformStatus')).toContainText('LIFF 尚未完成登入');
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  expect(h.providerCalls).toEqual([]);
  expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
