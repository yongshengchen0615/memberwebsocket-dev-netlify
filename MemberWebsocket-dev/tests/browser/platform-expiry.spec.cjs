const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const fixture=require('../integration/business-platform-fixture.cjs');
const term=require('../../platform/expiry-term.js');
let server,base;
const root=path.resolve(__dirname,'../..');
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const uri=new URL(req.url,'http://localhost');
  const file=path.resolve(root,'.'+(uri.pathname.endsWith('/')?uri.pathname+'index.html':uri.pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/json'});
  res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(resolve=>server.close(resolve)));
test('AC-EXP-005: super-admin sets 30 days, sees remaining days and persists across reopening',async({page})=>{
 const h=await fixture();
 try{
  await h.approve('U'+'2'.repeat(32),'expiry-browser');
  h.allowedOrigins.add(base);
  await page.addInitScript(()=>sessionStorage.setItem('platform-line-login-return-v1',String(Date.now())));
  await page.route('**/config.json',route=>route.fulfill({json:{
   supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',
   supabasePublishableKey:'sb_publishable_fixture',adminLiffId:'2010791619-admin',
   memberLiffId:'2010787602-member',platformLiffId:'2012065297-VunxFBj8'
  }}));
  await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:"window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=> 'root'};"}));
  await page.route('https://fixture.supabase.co/functions/v1/**',async route=>{
   const body=route.request().postDataJSON();
   const headers=new Headers(route.request().headers());headers.set('Origin',base);
   const result=await h.handler(new Request(route.request().url(),{method:'POST',headers,body:JSON.stringify(body)}));
   await route.fulfill({status:result.status,headers:Object.fromEntries(result.headers),body:await result.text()});
  });
  await page.goto(base+'/platform/');
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  const card=page.locator('#tenantList .tenant-card').filter({hasText:'expiry-browser'});
  await expect(card).toBeVisible();
  await expect(card.locator('.tenant-expiry-summary')).toContainText('剩餘天數：無期限');
  await card.getByRole('button',{name:'設定使用期限'}).click();
  await expect(page.locator('#expiryDialog')).toBeVisible();
  await page.locator('input[name="expiryMode"][value="term"]').check();
  await page.locator('#expiryDays').fill('30');
  await expect(page.locator('#expiryRemainingDays')).toContainText('30 天');
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#saveExpiry').click();
  await expect(page.locator('#expiryDialog')).toBeHidden();
  const row=(await h.db.query("select created_at,expires_at from platform_private.tenants where slug='expiry-browser'")).rows[0];
  expect(new Date(row.expires_at).toISOString()).toBe(term.termExpiry(row.created_at,30));
  await expect(card.locator('.tenant-expiry-summary')).toContainText('剩餘天數：30 天');
  await card.getByRole('button',{name:'設定使用期限'}).click();
  await expect(page.locator('input[name="expiryMode"][value="term"]')).toBeChecked();
  await expect(page.locator('#expiryDays')).toHaveValue('30');
  await page.locator('input[name="expiryMode"][value="exact"]').check();
  await expect(page.locator('#expiryAt')).toBeVisible();
  await page.locator('input[name="expiryMode"][value="unlimited"]').check();
  await expect(page.locator('#expiryComputedAt')).toHaveText('無到期日');
  await page.locator('#closeExpiry').click();
  const tenant=(await h.db.query("select id,version from platform_private.tenants where slug='expiry-browser'")).rows[0];
  const unauthorized=await h.call({action:'platform.tenant.expiry.save',tenantId:tenant.id,expectedVersion:tenant.version,requestId:crypto.randomUUID(),expiresAt:null},'manager');
  expect(unauthorized.status).toBe(403);
 }finally{await h.db.close();}
});
