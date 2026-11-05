const {test,expect}=require('playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const features={membership:'會員卡',points:'集點卡',booking:'預約'};
async function setup(page,{denied=false,empty=false,stored,blockedStorage=false}={}){
 const calls=[],errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 if(stored||blockedStorage)await page.addInitScript(({stored,blockedStorage})=>{
  if(stored)localStorage.setItem('lumen-color-theme-v1',stored);
  if(blockedStorage)Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');}});
 },{stored,blockedStorage});
 await page.context().route('https://fixture.test/**',route=>{
  const url=new URL(route.request().url());
  if(url.pathname.endsWith('config.json'))return route.fulfill({json:{merchantApprovalVersion:2,platformLiffId:'2012065297-root',supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'sb_publishable_fixture'}});
  const file=path.resolve(root,'.'+(url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
  return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(file)});
 });
 await page.context().route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:"window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>'synthetic-identity'}"}));
 await page.context().route('https://fixture.supabase.co/**',route=>{
  const input=route.request().postDataJSON();calls.push(input.action);
  if(denied)return route.fulfill({status:403,json:{ok:false,error:{code:'PLATFORM_ADMIN_REQUIRED',message:'denied'}}});
  const data=input.action==='platform.bootstrap'?{features,profile:{displayName:'Root'},applications:[],tenants:empty?[]:[{
   id:'tenant-1',version:1,name:'測試商家・總管理員亮暗色驗收',slug:'theme-fixture',status:'active',ownerLineUserId:'synthetic-owner',features:{membership:true,booking:true},createdAt:'2026-01-01T00:00:00Z',expiresAt:'2026-01-02T00:00:00Z',expired:true,onboarding:{adminReady:true}
  }]}:{qualifications:[]};
  return route.fulfill({json:{ok:true,data}});
 });
 await page.goto('https://fixture.test/platform/');
 await expect(page.locator(denied?'#platformAuthorizationNotice':'#platformWorkspace')).toBeVisible();
 return {calls,errors};
}
async function assertContrast(page,selectors){
 const colors=await page.evaluate(selectors=>selectors.map(selector=>{
  const element=document.querySelector(selector),style=getComputedStyle(element);
  let current=element,background;
  while(current){background=getComputedStyle(current).backgroundColor;if(background!=='rgba(0, 0, 0, 0)')break;current=current.parentElement;}
  return {selector,color:style.color,background};
 }),selectors);
 const luminance=color=>{
  const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
  return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
 };
 for(const {selector,color,background} of colors){
  const a=luminance(color),b=luminance(background);
  expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05),selector+' contrast '+color+' on '+background).toBeGreaterThanOrEqual(4.5);
 }
}
for(const width of [390,1280])test('AC-001/002/003 platform theme, cards and dialogs '+width+'px',async({page},info)=>{
 await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:'light'});
 const h=await setup(page),toggle=page.getByRole('button',{name:'切換為暗色調'});
 await expect(toggle).toBeVisible();
 await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 const initial=await page.locator('.tenant-card').evaluate(el=>getComputedStyle(el).backgroundColor);
 for(const theme of ['light','dark']){
  if(theme==='dark')await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await expect(page.locator('#themeToggleButton')).toHaveAttribute('aria-pressed',String(theme==='dark'));
  await assertContrast(page,['h1','.eyebrow','.tenant-card h3','.tenant-card p','.badge','.notice','#rootSyncNow','.tenant-card footer button','.tenant-expiry-summary','.tenant-expiry-summary strong.expired']);
  await page.getByRole('button',{name:'設定使用期限',exact:true}).click();
  await expect(page.locator('#expiryDialog')).toBeVisible();
  await page.locator('input[name="expiryMode"][value="term"]').check();
  await assertContrast(page,['#expiryTitle','#expiryStartedAt','#expiryDays','#expiryStartHint','.expiry-mode-options label:has(input:checked)','#expiryComputedAt','#saveExpiry']);
  expect(await page.locator('#expiryDialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await info.attach('platform-expiry-'+theme+'-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
  await page.locator('#closeExpiry').click();
  await page.getByRole('button',{name:'調整開放功能',exact:true}).click();
  await expect(page.locator('#grantDialog')).toBeVisible();
  await assertContrast(page,['#grantDialog h2','#grantDialog .features label','#grantDialog .hint']);
  await page.locator('#closeGrant').click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }
 expect(await page.locator('.tenant-card').evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe(initial);
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 const other=await page.context().newPage();await other.goto('https://fixture.test/platform/');
 await expect(other.locator('html')).toHaveAttribute('data-theme','dark');
 await page.locator('#themeToggleButton').focus();await page.keyboard.press('Enter');
 await expect(other.locator('html')).toHaveAttribute('data-theme','light');
 await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await other.close();
 expect(h.calls.every(action=>['platform.bootstrap','platform.qualification.list'].includes(action))).toBe(true);
 expect(h.errors).toEqual([]);
});
test('AC-001 follows device changes and rejects invalid stored preferences',async({page})=>{
 await page.emulateMedia({colorScheme:'dark'});await setup(page,{stored:'invalid',empty:true});
 await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await assertContrast(page,['#tenantList .empty']);
 await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
});
test('AC-001 blocked storage still permits appearance changes',async({page})=>{
 await page.emulateMedia({colorScheme:'dark'});const h=await setup(page,{blockedStorage:true});
 await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.getByRole('button',{name:'切換為亮色調'}).click();
 await expect(page.locator('html')).toHaveAttribute('data-theme','light');expect(h.errors).toEqual([]);
});
test('AC-003 appearance remains available after server denies platform access',async({page})=>{
 const h=await setup(page,{denied:true});
 await expect(page.locator('#platformWorkspace')).toBeHidden();
 await page.locator('#themeToggleButton').click();
 await expect(page.locator('#platformWorkspace')).toBeHidden();
 await assertContrast(page,['#platformAuthorizationTitle']);
 expect(h.calls).toEqual(['platform.bootstrap']);expect(h.errors).toEqual([]);
});
