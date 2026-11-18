const {test,expect}=require('playwright/test');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
for(const width of [390,1280])test(`AC-001/002 event summary retains completion while an older HTTP read is in flight ${width}`,async({page})=>{
 await page.setViewportSize({width,height:800});
 let finishFirst,requests=0;
 await page.route('https://app.test/event/',route=>route.fulfill({contentType:'text/html',body:'<button id="ticketModalAction">使用票券</button><div><p id="eventSummary"></p></div>'}));
 await page.route('https://fixture.supabase.co/functions/v1/event-ticket-extension-api',async route=>{
  requests++;
  if(requests===1)await new Promise(resolve=>{finishFirst=resolve;});
  await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:{usedTodayCount:requests===1?0:1,maxTicketsPerDay:5}})});
 });
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('https://app.test/event/');
 await page.evaluate(()=>{window.MemberSystem={getSession:()=>({idToken:'synthetic-member',config:{supabaseUrl:'https://fixture.supabase.co',supabasePublishableKey:'synthetic-public',business:'shop-a'}})};});
 await page.addScriptTag({path:path.join(root,'event/today-usable.js')});
 await page.clock.install();
 await page.locator('#ticketModalAction').click();await page.clock.runFor(801);expect(requests).toBe(0);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect.poll(()=>requests).toBe(1);
 await page.evaluate(()=>{for(let i=0;i<100;i++)window.dispatchEvent(new Event('event-ticket:redeemed'));});
 finishFirst();await expect.poll(()=>requests).toBe(2);
 await expect(page.locator('#todayUsableTicketCount')).toContainText('今日已使用 1 張');
 expect(errors).toEqual([]);
});
