const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const businessFixture=require('../integration/business-platform-fixture.cjs');
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

test('AC-PLAT-207: LINE creates super_admins pending; only a Supabase Table Editor toggle activates and revokes in a real browser',async({context})=>{
 const h=await businessFixture();h.allowedOrigins.add(base);
 const pages=[];
 async function open(actor){
  const page=await context.newPage();pages.push(page);
  await page.addInitScript(()=>sessionStorage.setItem('platform-line-login-return-v1',String(Date.now())));
  await page.route('**/config.json',route=>route.fulfill({json:{
   supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',
   supabasePublishableKey:'sb_publishable_fixture',adminLiffId:'2010791619-admin',
   memberLiffId:'2010787602-member',platformLiffId:'2012065297-VunxFBj8'
  }}));
  await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:
   'window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>'+JSON.stringify(actor)+'};'}));
  await page.route('https://cdn.jsdelivr.net/**',route=>route.fulfill({contentType:'text/javascript',body:''}));
  await page.route('https://fixture.supabase.co/functions/v1/**',async route=>{
   const body=route.request().postDataJSON();
   const headers=new Headers(route.request().headers());headers.set('Origin',base);
   const response=await h.handler(new Request(route.request().url(),{
    method:'POST',headers,body:JSON.stringify(body)
   }));
   await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  await page.goto(base+'/platform/');
  return page;
 }
 try{
  const manager=await open('manager');
  await expect(manager.locator('#platformAuthorizationNotice')).toBeVisible();
  await expect(manager.locator('#platformWorkspace')).toBeHidden();
  await expect(manager.locator('#platformAuthorizationNotice')).toHaveText('總管理員權限尚未核准');
  await expect(manager.locator('#platformStatus')).toBeHidden();
  await expect(manager.locator('#platformHeader')).toBeHidden();
  await expect(manager.locator('#platformLoginGate,#platformLoginButton')).toHaveCount(0);
  const pending=(await h.db.query('select singleton,admin_id,enabled,display_name from platform_private.super_admins where line_user_id=$1',['U'+'2'.repeat(32)])).rows[0];
  expect(pending.singleton).toBe(null);
  expect(pending.admin_id).toBe(null);
  expect(pending.enabled).toBe(false);
  expect(pending.display_name).toBe('商家管理員');
  await h.db.exec("update platform_private.super_admins set enabled=true where line_user_id='U22222222222222222222222222222222'");
  await manager.reload();
  await expect(manager.locator('#platformWorkspace')).toBeVisible();
  await expect(manager.locator('#platformAccessPanel')).toHaveCount(0,'not approved through Platform UI');
  await h.db.exec("update platform_private.super_admins set enabled=false where line_user_id='U22222222222222222222222222222222'");
  await manager.reload();
  await expect(manager.locator('#platformAuthorizationNotice')).toBeVisible();
  await expect(manager.locator('#platformWorkspace')).toBeHidden();
  expect((await h.db.query("select enabled from platform_private.super_admins where line_user_id='U22222222222222222222222222222222'")).rows[0].enabled).toBe(false);
 }finally{for(const page of pages)await page.close();await h.db.close();}
});
