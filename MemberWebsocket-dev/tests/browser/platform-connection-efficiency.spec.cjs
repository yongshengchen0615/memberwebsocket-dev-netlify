const {test,expect}=require('playwright/test');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const features={membership:'會員卡',points:'集點卡',events:'活動票券',calendar:'營運日曆',booking:'預約'};
async function setup(page,{merchant=false}={}){
 const calls=[],errors=[];let hold=false;const release=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  window.fixtureOnline=true;Object.defineProperty(navigator,'onLine',{get:()=>window.fixtureOnline});
  window.fixtureIntervals=[];window.setInterval=(fn,delay)=>{const entry={fn,delay,active:true};window.fixtureIntervals.push(entry);return window.fixtureIntervals.length;};
  window.clearInterval=id=>{if(window.fixtureIntervals[id-1])window.fixtureIntervals[id-1].active=false;};
 });
 await page.route('https://fixture.test/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.endsWith('config.json'))return route.fulfill({json:{merchantApprovalVersion:2,platformLiffId:'2012065297-root',adminLiffId:'2010791619-admin',supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'sb_publishable_fixture'}});
  const name=url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname;
  const file=path.resolve(root,'.'+name);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
  return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(file)});
 });
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:"window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>'synthetic-identity'}"}));
 await page.route('https://fixture.supabase.co/**',async route=>{
  const input=route.request().postDataJSON();calls.push(input);
  if(hold)await new Promise(resolve=>release.push(resolve));
  const data=input.action==='platform.bootstrap'?{tenants:[],applications:[],features,profile:{displayName:'Root'}}
   :input.action==='platform.qualification.list'?{qualifications:[]}
   :input.action==='platform.qualification.bootstrap'?{qualification:{id:'q-1',status:'approved',version:1,displayName:'Admin'}}
   :{applications:[]};
  return route.fulfill({json:{ok:true,data}});
 });
 await page.goto('https://fixture.test/'+(merchant?'admin/workspace.html':'platform/'));
 await expect(page.locator(merchant?'#myMerchantsWorkspace':'#platformWorkspace')).toBeVisible();
 return{calls,errors,hold(){hold=true;},release(){hold=false;release.splice(0).forEach(resolve=>resolve());}};
}

test('AC-PERF-002 Chromium: root starts both reads before either returns and coalesces repeated signals',async({page})=>{
 const h=await setup(page);try{
  h.hold();const before=h.calls.length;
  await page.locator('#rootSyncNow').click();
  await expect.poll(()=>h.calls.length-before).toBe(2);
  expect(h.calls.slice(before).map(call=>call.action).sort()).toEqual(['platform.bootstrap','platform.qualification.list']);
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));});
  expect(h.calls.length-before).toBe(2);
  await expect(page.locator('#rootSyncNow')).toBeDisabled();
  h.release();await expect(page.locator('#rootSyncNow')).toBeEnabled();
  expect(h.errors).toEqual([]);
 }finally{h.release();}
});

for(const merchant of [false,true])test(`AC-PERF-003 Chromium: ${merchant?'merchant mobile':'root desktop'} makes no offline polls and recovers online`,async({page})=>{
 if(merchant)await page.setViewportSize({width:390,height:844});
 const h=await setup(page,{merchant});const before=h.calls.length;
 await page.evaluate(()=>{
  window.fixtureOnline=false;
  for(let i=0;i<12;i++)for(const timer of window.fixtureIntervals.filter(timer=>timer.active))timer.fn();
  window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));
 });
 // Browser task boundary, not a wall-clock sleep; all guarded callbacks ran synchronously.
 await page.evaluate(()=>{});expect(h.calls.length).toBe(before);
 await page.evaluate(()=>{window.fixtureOnline=true;window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('online'));});
 await expect.poll(()=>h.calls.length-before).toBe(2);
 expect(h.errors).toEqual([]);
});
