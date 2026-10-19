const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(root,'.'+(pathname.endsWith('/')?pathname+'index.html':pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end()}
  res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/json'});
  res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(resolve=>server.close(resolve)));
const flags=Object.fromEntries(['membership','points','events','calendar','integrations','booking','testing','usage'].map(f=>[f,f==='membership']));
const tenantId='10000000-0000-4000-8000-000000000001';
const applicant={id:'20000000-0000-4000-8000-000000000002',businessName:'綠光美學',slug:'green-light',status:'pending',tenantId:null};
async function mockV2(page,routeFn){
 await page.route('**/v2/config.json',r=>r.fulfill({json:{apiUrl:'https://v2.example.supabase.co/functions/v1/platform-v2',platformLiffId:'2012345678-unique',environment:'sandbox'}}));
 await page.route('https://static.line-scdn.net/**',r=>r.fulfill({contentType:'text/javascript',body:"window.liff={init:async()=>{},isLoggedIn:()=>true,getIDToken:()=> 'synthetic-v2-token',login:()=>{}};"}));
 await page.route('https://v2.example.supabase.co/functions/v1/platform-v2',async r=>{
   const input=r.request().postDataJSON();
   await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,data:await routeFn(input)})});
 });
}
test('V2-ADMIN-E2E: starts pending, only granted modules allow LINE setup',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));let submitted=false;
 await mockV2(page,async payload=>{
   if(payload.action==='application.ensure'||payload.action==='application.apply'){
     if(payload.action==='application.apply')submitted=true;
     return {scope:'merchant',application:submitted?{...applicant,businessName:payload.businessName,slug:payload.slug}:applicant,tenant:null};
   }
   throw Error('unexpected V2 action '+payload.action);
 });
 await page.goto(base+'/v2/admin/');
 await page.getByRole('button',{name:'LINE 登入'}).click();
 await expect(page.locator('#workspace')).toBeVisible();
 await expect(page.locator('#featureGrid .feature-card')).toHaveCount(8);
 await expect(page.locator('#featureGrid button')).toHaveCount(8);
 await expect(page.locator('#featureGrid button:enabled')).toHaveCount(0);
 await page.locator('#applyName').fill('星空咖啡');
 await page.locator('#applySlug').fill('star-cafe');
 await page.getByRole('button',{name:'送出申請'}).click();
 await expect(page.locator('#businessName')).toHaveText('星空咖啡');
 expect(submitted).toBe(true);expect(errors).toEqual([]);
});
test('V2-PLATFORM-E2E: only toggles features and never asks for tenant secrets',async({page})=>{
 let approval;let approved=false;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await mockV2(page,async payload=>{
   if(payload.action==='bootstrap')return {
     scope:'platform',
     applications:[approved?{...applicant,status:'approved',tenantId}:applicant],
     tenants:approved?[{id:tenantId,name:'綠光美學',slug:'green-light',status:'pending_provisioning',version:1,features:approval,line:{}}]:[]
   };
   if(payload.action==='application.approve'){approval=payload.features;approved=true;return {id:tenantId};}
   throw Error('unexpected action '+payload.action);
 });
 await page.goto(base+'/v2/platform/');
 await page.getByRole('button',{name:'確認 LINE 身分'}).click();
 await expect(page.locator('#workspace')).toBeVisible();
 await expect(page.locator('#applications .application-card')).toHaveCount(1);
 await page.locator('#applications input[data-feature="booking"]').check();
 await page.getByRole('button',{name:'核准功能並建立待佈建商家'}).click();
 await expect(page.locator('#reviewCount')).toContainText('0 筆待審核');
 expect(approval.booking).toBe(true);expect(approval.membership).toBe(false);
 await expect(page.locator('#tenants')).toContainText('獨立環境佈建中');
 await expect(page.locator('input[type=password]')).toHaveCount(0);
 expect(errors).toEqual([]);
});
test('V2-PREVIEW-E2E: unconfigured environment fails closed, including mobile layout',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.route('https://static.line-scdn.net/**',r=>r.fulfill({contentType:'text/javascript',body:'window.liff={};'}));
 await page.goto(base+'/v2/admin/');
 await expect(page.locator('#notice')).toContainText('尚未配置');
 await expect(page.locator('#signIn')).toBeDisabled();
 const width=await page.evaluate(()=>document.documentElement.scrollWidth);
 expect(width).toBeLessThanOrEqual(390);
});
