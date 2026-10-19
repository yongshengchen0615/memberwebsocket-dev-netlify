const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const businessFixture=require('../integration/business-platform-fixture.cjs');
let server,base;const root=path.resolve(__dirname,'../..');
test.beforeAll(async()=>{server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');const file=path.resolve(root,'.'+(u.pathname.endsWith('/')?u.pathname+'index.html':u.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/json'});res.end(fs.readFileSync(file));});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.afterAll(async()=>new Promise(r=>server.close(r)));
test('BUSINESS_APPROVAL_ACTIVATES — real approval/SQL immediately opens grant-scoped admin and client links without LINE setup',async({context},info)=>{
 const h=await businessFixture();h.allowedOrigins.add(base);const errors=[];
 async function wire(page,token){
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.addInitScript(()=>sessionStorage.setItem('platform-line-login-return-v1',String(Date.now())));
  await page.route('**/config.json',r=>r.fulfill({json:{brandName:'QA',supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'sb_publishable_fixture',adminLiffId:'2010791619-admin',memberLiffId:'2010787602-member',pointsLiffId:'2010787602-points',platformLiffId:'2012065297-VunxFBj8',productizedAdmin:true}}));
  await page.route('https://static.line-scdn.net/**',r=>r.fulfill({contentType:'text/javascript',body:`window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>${JSON.stringify(token)}};`}));
  await page.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({contentType:'text/javascript',body:''}));
  await page.route('https://fixture.supabase.co/functions/v1/**',async route=>{
   const body=route.request().postDataJSON(),headers=new Headers(route.request().headers());headers.set('Origin',base);
   if(route.request().url().endsWith('/platform-api')){const response=await h.handler(new Request(route.request().url(),{method:'POST',headers,body:JSON.stringify(body)}));return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});}
   // This transport renders the real admin UI from the newly provisioned DB.
   // Authentication/routing/feature enforcement are tested by the production
   // request adapter test; only the browser's external business HTTP is replaced.
   const t=(await h.db.query('select * from platform_private.tenants where slug=$1',[body.business])).rows[0];
   if(!t)return route.fulfill({status:403,json:{ok:false,error:{code:'BUSINESS_NOT_FOUND',message:'missing'}}});
   const {assertBusinessAction}=await import('../../supabase/functions/_shared/business-policy.mjs');
   try{assertBusinessAction(t,body.action,body);}catch(e){return route.fulfill({status:403,json:{ok:false,error:{code:e.code,message:e.message}}});}
   let data={};
   if(body.action==='admin.bootstrap')data={profile:{displayName:t.name},role:'Admin',business:{name:t.name,slug:t.slug},features:t.features,members:[],memberPage:{page:1,pageSize:100,total:0,totalPages:1,query:''},tierSettings:[],cards:[],tickets:[],eventTickets:[],calendarItems:[],messagePresets:[],bookingServices:[],stats:{}};
   return route.fulfill({json:{ok:true,data}});
  });
 }
 const manager=await context.newPage(),platform=await context.newPage();
 try{
  await wire(manager,'manager');await manager.goto(base+'/admin/workspace.html');await expect(manager.locator('#applicationProgress')).toContainText('等待總管理員審核');
  await wire(platform,'root');await platform.goto(base+'/platform/');await platform.getByRole('button',{name:'審核與選擇功能'}).click();
  await platform.locator('[data-approve-feature="membership"]').check();await platform.locator('[data-approve-feature="points"]').check();await platform.getByRole('button',{name:'審核通過',exact:true}).click();
  await expect(platform.locator('#tenantList')).toContainText('可立即使用');
  const row=(await h.db.query('select * from platform_private.tenants')).rows[0];expect(row.status).toBe('active');expect(row.credentials_configured).toBe(false);
  await manager.locator('#refreshApplication').click();await expect(manager.locator('#merchantLaunchStatus')).toHaveAttribute('data-ready','true');
  await expect(manager.locator('[data-business-launch][href^="/member/"]')).toHaveAttribute('href','/member/?business='+row.slug);
  await expect(manager.locator('[data-business-launch][href^="/points/"]')).toHaveCount(1);
  await expect(manager.locator('[data-business-launch][href^="/booking/"]')).toHaveCount(0);
  await manager.locator('[data-business-launch][href^="/admin/"]').click();await expect(manager.locator('#businessWorkspaceStatus')).toContainText('審核已通過');
  await expect(manager.locator('#membersTab')).toBeVisible();await expect(manager.locator('#cardsTab')).toBeVisible();await expect(manager.locator('#eventsTab')).toBeHidden();await expect(manager.locator('#bookingTab')).toBeHidden();
  expect(errors).toEqual([]);await info.attach('approved-business-admin',{body:await manager.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await manager.close();await platform.close();await h.db.close();}
});
