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

test('AC-PLAT-106: verified login writes pending SQL record; root grants and revokes in actual browser',async({context})=>{
 const h=await businessFixture();h.allowedOrigins.add(base);
 const pages=[];
 async function open(actor){
  const page=await context.newPage();pages.push(page);
  page.on('dialog',dialog=>dialog.accept());
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
  let pending=(await h.db.query('select line_user_id,access_enabled from platform_private.platform_access_requests')).rows;
  expect(pending).toHaveLength(1);
  expect(pending[0].access_enabled).toBe(false);
  const owner=await open('root');
  await expect(owner.locator('#platformAccessPanel')).toBeVisible();
  await expect(owner.locator('#platformAccessList')).toContainText('商家管理員');
  await owner.getByRole('button',{name:'核准 Platform 權限'}).click();
  await expect(owner.locator('#platformAccessList')).toContainText('已授予 Platform 管理權');
  await manager.reload();
  await expect(manager.locator('#platformWorkspace')).toBeVisible();
  await expect(manager.locator('#platformAccessPanel')).toBeHidden();
  await owner.getByRole('button',{name:'撤銷 Platform 權限'}).click();
  await expect(owner.locator('#platformAccessList')).toContainText('待核准');
  await manager.reload();
  await expect(manager.locator('#platformAuthorizationNotice')).toBeVisible();
  await expect(manager.locator('#platformWorkspace')).toBeHidden();
  const audits=(await h.db.query("select action from platform_private.audit_events where action like 'PLATFORM_OPERATOR_%'")).rows;
  expect(audits).toHaveLength(2);
 }finally{for(const page of pages)await page.close();await h.db.close();}
});


test('AC-PLAT-113: Supabase enabled checkbox, not Platform self-approval, unlocks first root in browser',async({context})=>{
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
  await h.db.exec('delete from platform_private.super_admins;delete from public.admins;');
  const page=await open('root');
  await expect(page.locator('#platformAuthorizationNotice')).toBeVisible();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
  const before=(await h.db.query('select enabled,line_user_id from platform_private.super_admins')).rows;
  expect(before).toEqual([{enabled:false,line_user_id:h.root}]);
  await h.db.exec('update platform_private.super_admins set enabled=true where singleton=true');
  await page.reload();
  await expect(page.locator('#platformWorkspace')).toBeVisible();
  await h.db.exec('update platform_private.super_admins set enabled=false where singleton=true');
  await page.reload();
  await expect(page.locator('#platformAuthorizationNotice')).toBeVisible();
  await expect(page.locator('#platformWorkspace')).toBeHidden();
 }finally{for(const page of pages)await page.close();await h.db.close();}
});
