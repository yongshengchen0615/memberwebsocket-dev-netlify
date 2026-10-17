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
async function setup(page,token='root',{loseFirstSave=false}={}) {
 const h=await fixture();let lost=false;const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.route('**/config.json',route=>route.fulfill({json:{brandName:'QA Platform',supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'sb_publishable_fixture',adminLiffId:'2010791619-admin'}}));
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:`window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>${JSON.stringify(token)}};`}));
 await page.route('https://fixture.supabase.co/functions/v1/platform-api',async route=>{
  const input=route.request().postDataJSON();
  const response=await h.handler(new Request(route.request().url(),{method:'POST',headers:{Origin:'https://allowed.test'},body:JSON.stringify(input)}));
  if(loseFirstSave&&!lost&&input.action==='platform.tenant.save'){lost=true;return route.abort('failed');}
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
 });
 await page.goto(base+'/platform/');return {...h,errors};
}
async function fillNew(page,tenant) {
 await page.getByRole('button',{name:'新增商家管理員'}).click();
 for(const key of ['name','slug','ownerLineUserId'])await page.locator(`[name="${key}"]`).fill(tenant[key]);
 for(const [key,value] of Object.entries(tenant.line))await page.locator(`[name="${key}"]`).fill(value);
 for(const [key,value] of Object.entries(tenant.credentials))await page.locator(`[name="${key}"]`).fill(value);
 for(const key of ['membership','points','booking'])await page.locator(`[data-feature="${key}"]`).check();
}
test('PLATFORM_CREATE_EDIT — root saves merchant, eight grants and encrypted LINE credentials through real handler + SQL',async({page},info)=>{
 const h=await setup(page);try{
  await expect(page.locator('#platformWorkspace')).toBeVisible();await fillNew(page,h.tenant);
  await expect(page.locator('[name="channelAccessToken"]')).toHaveAttribute('type','password');await expect(page.locator('[data-feature]')).toHaveCount(8);
  await page.getByRole('button',{name:'儲存商家設定',exact:true}).click();await expect(page.locator('#tenantDialog')).toBeHidden();await expect(page.locator('.tenant-card')).toHaveCount(1);await expect(page.locator('.tenant-card')).toContainText('待佈建');
  let row=(await h.db.query('select * from platform_private.tenants')).rows[0];expect(row.features.booking).toBe(true);expect(row.features.testing).toBe(false);
  const before=(await h.db.query('select envelope from platform_private.tenant_secrets')).rows[0].envelope;
  await page.getByRole('button',{name:'編輯設定'}).click();await expect(page.locator('[name="channelAccessToken"]')).toHaveValue('');await expect(page.locator('[name="channelSecret"]')).toHaveValue('');
  await page.locator('[data-feature="booking"]').uncheck();await page.locator('[name="name"]').fill('商家 A 更新');await page.getByRole('button',{name:'儲存商家設定',exact:true}).click();await expect(page.locator('#tenantDialog')).toBeHidden();await expect(page.locator('.tenant-card')).toContainText('商家 A 更新');
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
test('PLATFORM_DENIED — ordinary active admin cannot load root control or merchant settings',async({page})=>{
 const h=await setup(page,'manager');try{await expect(page.locator('#platformStatus')).toContainText('僅總管理員');await expect(page.locator('#platformWorkspace')).toBeHidden();expect(h.errors).toEqual([]);}finally{await h.db.close();}
});
test('PLATFORM_MOBILE — merchant form fits narrow screen and renders merchant names as text',async({page},info)=>{
 await page.setViewportSize({width:390,height:844});const h=await setup(page);try{
  await expect(page.locator('#platformWorkspace')).toBeVisible();await fillNew(page,{...h.tenant,name:'<img src=x onerror=alert(1)>'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await info.attach('platform-mobile-form',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
  await page.getByRole('button',{name:'儲存商家設定',exact:true}).click();await expect(page.locator('#tenantDialog')).toBeHidden();await expect(page.locator('.tenant-card h3')).toHaveText('<img src=x onerror=alert(1)>');expect(await page.locator('.tenant-card img').count()).toBe(0);expect(h.errors).toEqual([]);
 }finally{await h.db.close();}
});
