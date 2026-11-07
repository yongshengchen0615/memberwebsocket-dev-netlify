const {test,expect}=require('playwright/test');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'../..');let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),file=path.resolve(root,'.'+(url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript');
  let content=fs.readFileSync(file);
  if(file.endsWith('.html'))content=content.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  res.end(content);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(r=>server.close(r)));
const items=[{kind:'points',id:'R',selectionId:'P',selectable:true,title:'合成集點券',cardId:'C',pointCost:1,pointBalance:10},
 {kind:'event',id:'E',selectionId:'E',selectable:true,title:'合成活動券'}];
for(const width of [390,1280])test(`AC-MEMBER-001..004_${width}: real booking revision updates grants, open snapshot dialog and stale selections`,async({page},info)=>{
 let features={booking:true,membership:true,points:true,events:true,calendar:true},revision='1';const calls=[],errors=[];
 await page.setViewportSize({width,height:900});await page.clock.install({time:new Date('2026-11-07T00:00:00Z')});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fixture.supabase.co/**',route=>{
  if(!route.request().url().startsWith('https://fixture.supabase.co/'))return route.abort();
  const body=route.request().postDataJSON();calls.push(body);
  if(body.action==='platform.business.public')return route.fulfill({json:{ok:true,data:{business:'merchant-a',name:'QA',features,line:{}}}});
  if(body.action.endsWith('.sync.status')&&!features.booking)return route.fulfill({status:403,json:{ok:false,error:{code:'FEATURE_DISABLED',message:'未開通'}}});
  return route.fulfill({json:{ok:true,data:{revision,items,snapshotLocationRequired:false,snapshotLocations:[],bookings:[],submissions:[]}}});
 });
 await page.goto(base+'/booking/?business=merchant-a');
 for(const file of ['business-context.js','booking/common.js','ui-components.js','booking/booking-benefits.js','booking/booking-receipt.js','booking/booking-accessible.js'])await page.addScriptTag({url:base+'/'+file});
 await page.clock.pauseAt(new Date('2026-11-07T00:01:00Z'));
 await page.evaluate(async()=>{
  window.cfg={supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'fixture',bookingLiffId:'booking'};
  await BusinessContext.configure(cfg);await BookingSystem.completeSignIn(cfg,'booking','synthetic-token');
  window.dispatchEvent(new Event('DOMContentLoaded'));
  document.getElementById('loadingView').classList.add('hidden');document.getElementById('bookingView').classList.remove('hidden');
  document.getElementById('appointmentPanel').classList.remove('hidden');
  BookingBenefits.start(cfg,'synthetic-token');
  window.stopSync=BookingSystem.subscribeRealtime(cfg,()=>{BookingBenefits.syncNow();});
 });
 await page.clock.runFor(1);
 await expect(page.locator('.booking-benefit-group[data-benefit-kind="points"]')).toBeVisible();
 await page.evaluate(()=>BookingBenefits.setSelection([{kind:'points',id:'P'},{kind:'event',id:'E'}]));
 await page.locator('#memberNote').fill('保留的預約草稿');
 features={booking:true,events:true};revision='2';await page.clock.runFor(3001);
 await expect(page.locator('.booking-benefit-group[data-benefit-kind="points"]')).toHaveCount(0);
 await expect(page.locator('.booking-benefit-group[data-benefit-kind="event"]')).toBeVisible();
 await expect(page.locator('#membershipProgress')).toBeHidden();
 expect(await page.evaluate(()=>BookingBenefits.selectionPayload())).toEqual([{kind:'event',id:'E'}]);
 await page.evaluate(()=>BookingBenefits.clearSelection());
 await expect(page.locator('#bookingBenefitsStatus')).not.toContainText('集點卡');
 await expect(page.locator('#bookingBenefits')).not.toContainText(/點數仍在讀取/);
 await page.evaluate(()=>document.getElementById('appointmentPanel').classList.add('hidden'));
 await page.locator('#bookingAccessibleToggle').click();
 await page.locator('#bookingAccessibleUpload').click();
 await expect(page.locator('#snapshotTicketFields')).toBeVisible();
 await expect(page.locator('[data-snapshot-kind="points"]')).toHaveCount(0);
 await page.locator('[data-snapshot-kind="event"]').check();
 await expect(page.locator('#snapshotTicketSelectionSummary')).not.toContainText('集點卡');
 features={booking:true};revision='3';await page.clock.runFor(3001);
 await expect(page.locator('#snapshotTicketFields')).toBeHidden();
 await expect(page.locator('#bookingAccessibleTicketHeading')).toBeHidden();
 expect(await page.locator('[data-snapshot-id]:checked').count()).toBe(0);
 features={booking:true,points:true};revision='4';await page.clock.runFor(3001);
 await expect(page.locator('#snapshotTicketFields')).toBeVisible();
 await expect(page.locator('[data-snapshot-kind="points"]')).toHaveCount(1);
 await expect(page.locator('[data-snapshot-kind="event"]')).toHaveCount(0);
 await expect(page.locator('#snapshotTicketSelectionSummary')).not.toContainText('活動票券');
 features={points:true};revision='5';await page.clock.runFor(3001);
 await expect(page.locator('#bookingView')).toBeHidden();await expect(page.locator('#bookingReceiptModal')).toBeHidden();
 expect(await page.locator('#memberNote').inputValue()).toBe('保留的預約草稿');
 await page.evaluate(()=>stopSync());
 expect(calls.filter(b=>b.action==='platform.business.public').every(b=>b.business==='merchant-a')).toBe(true);
 expect(calls.filter(b=>b.action==='platform.business.public').slice(1).every(b=>!b.feature)).toBe(true);
 expect(errors).toEqual([]);
 await info.attach('member-grants-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
});

test('AC-MEMBER-003: MemberSystem updates member cross-module links on revision changes with no idle public reads',async({page})=>{
 let features={membership:true,points:true,events:true},revision='1';let reads=0;
 await page.clock.install({time:new Date('2026-11-07T00:00:00Z')});
 await page.route('https://fixture.supabase.co/**',route=>{
  if(!route.request().url().startsWith('https://fixture.supabase.co/'))return route.abort();
  const b=route.request().postDataJSON();
  if(b.action==='platform.business.public'){reads++;return route.fulfill({json:{ok:true,data:{business:'merchant-a',name:'QA',features,line:{}}}});}
  return route.fulfill({json:{ok:true,data:{revision,state:'claimed'}}});
 });
 await page.goto(base+'/member/?business=merchant-a');
 for(const file of ['business-context.js','member-system.js'])await page.addScriptTag({url:base+'/'+file});
 await page.clock.pauseAt(new Date('2026-11-07T00:01:00Z'));
 await page.evaluate(async()=>{
  window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=> 'synthetic'};
  const config={supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'fixture',memberLiffId:'member'};
  await BusinessContext.configure(config);await MemberSystem.signIn(config,'member');
  window.syncMetrics=[];
  window.addEventListener('member-system:sync-metrics',event=>window.syncMetrics.push(event.detail));
  const view=document.getElementById('memberView');view.classList.remove('hidden');
  view.insertAdjacentHTML('beforeend','<a id="pointsLink" href="/points/?business=merchant-a">集點卡</a><a id="eventsLink" href="/event/?business=merchant-a">活動票券</a>');
  window.stopSync=MemberSystem.subscribeRealtime(config,'member',async()=>{});
 });
 await page.clock.runFor(1);
 await expect.poll(()=>page.evaluate(()=>window.syncMetrics.length)).toBeGreaterThan(0);
 await expect(page.locator('#pointsLink')).toBeVisible();
 const initialReads=reads,initialProbes=await page.evaluate(()=>window.syncMetrics.length);
 // Three healthy 10s intervals cover the same idle 30s. Advancing 30s in one
 // jump also fires the real read's 15s deadline before HTTP can settle.
 for(let i=0;i<3;i++){
  const completed=await page.evaluate(()=>window.syncMetrics.length);
  await page.clock.runFor(10000);
  await expect.poll(()=>page.evaluate(()=>window.syncMetrics.length)).toBeGreaterThan(completed);
 }
 expect(reads).toBe(initialReads);
 expect(await page.evaluate(n=>window.syncMetrics.slice(n).every(m=>m.changed===false),initialProbes)).toBe(true);
 features={membership:true,events:true};revision='2';await page.clock.runFor(10001);
 await expect(page.locator('#pointsLink')).toBeHidden();await expect(page.locator('#eventsLink')).toBeVisible();
 features={membership:true,points:true};revision='3';await page.clock.runFor(10001);
 await expect(page.locator('#pointsLink')).toBeVisible();await expect(page.locator('#eventsLink')).toBeHidden();
 await page.evaluate(()=>stopSync());
});
