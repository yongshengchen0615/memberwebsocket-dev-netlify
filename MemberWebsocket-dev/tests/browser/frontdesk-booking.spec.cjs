const {test,expect}=require('playwright/test'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
let server,base;
test.beforeAll(async()=>{server=http.createServer((req,res)=>{
 const route=req.url.split('?')[0];
 if(route==='/config/config.json'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic-public'}));}
 const file={'/frontdesk/':'frontdesk/index.html','/frontdesk/app.js':'frontdesk/app.js','/frontdesk/styles.css':'frontdesk/styles.css','/admin/frontdesk-settings.js':'admin/frontdesk-settings.js'}[route];
 if(!file){res.statusCode=404;return res.end();}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(fs.readFileSync(path.resolve(__dirname,'../..',file)));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;});
test.afterAll(async()=>new Promise(resolve=>server.close(resolve)));
for(const width of [390,1280])test('FRONTDESK_'+width+' — notify-only, scoped review, downgrade and lost-response replay',async({page},info)=>{
 await page.emulateMedia({colorScheme:width===390?'dark':'light'});
 let mode='notify_only',status='pending',lose=false,downgrade=false;const calls=[],ids=[];
 await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:'dark'});
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:'window.liff={init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>"verified-staff",login:()=>{},logout:()=>{}};'}));
 await page.route('https://fixture.supabase.co/**',async route=>{
  const b=route.request().postDataJSON();calls.push(b);expect(b.business).toBe('shop-a');let data;
  if(b.action==='frontdesk.public')data={name:'測試商家',frontdesk:{enabled:true,liffId:'2010999999-desk',oaId:'@desk'}};
  else if(b.action==='frontdesk.bootstrap')data={staff:{displayName:'櫃檯 A',status:'approved',permissionMode:mode}};
  else if(b.action==='frontdesk.bookings')data={bookings:status==='pending'?[{id:'10000000-0000-4000-8000-000000000001',status,updatedAt:'2026-11-18T12:00:00+08:00',name:'林小姐',phone:'0900000000',partySize:2,startAt:'2026-11-20T10:00:00',endAt:'2026-11-20T11:00:00',services:[{title:'測試服務',quantity:2}]}]:[]};
  else if(b.action==='frontdesk.booking.update'){
   if(downgrade){mode='notify_only';return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'FRONTDESK_REVIEW_REQUIRED',message:'你目前沒有確認或拒絕預約的權限。'}})});}
   ids.push(b.requestId);status=b.status;if(lose){lose=false;return route.abort('failed');}data={booking:{status},alreadyApplied:ids.length>1};
  }else throw Error('UNEXPECTED_ACTION '+b.action);
  await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
 });
 await page.goto(base+'/frontdesk/?business=shop-a');await expect(page.locator('#account')).toContainText('僅接收預約訊息');await expect(page.locator('[data-review-action]')).toHaveCount(0);expect(calls.some(x=>x.action==='frontdesk.bookings')).toBe(false);if(width===390){const contrast=await page.getByRole('link',{name:'加入櫃檯官方帳號'}).evaluate(a=>{const rgb=s=>s.match(/\d+/g).slice(0,3).map(Number),luma=c=>c.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);const x=luma(rgb(getComputedStyle(a).color)),y=luma(rgb(getComputedStyle(document.body).backgroundColor));return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);});expect(contrast).toBeGreaterThanOrEqual(4.5);}
 mode='review';await page.getByRole('button',{name:'重新整理'}).click();await expect(page.getByRole('button',{name:'確認預約',exact:true})).toBeVisible();await info.attach('frontdesk-pending-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 downgrade=true;await page.getByRole('button',{name:'確認預約',exact:true}).click();await expect(page.locator('#account')).toContainText('僅接收預約訊息');await expect(page.locator('#status')).toContainText('沒有');expect(status).toBe('pending');
 downgrade=false;mode='review';await page.getByRole('button',{name:'重新整理'}).click();lose=true;await page.getByRole('button',{name:'確認預約',exact:true}).click();await expect(page.getByRole('button',{name:'重試相同操作'})).toBeVisible();
 await page.getByRole('button',{name:'拒絕預約',exact:true}).click();expect(ids).toHaveLength(1);await expect(page.locator('#status')).toContainText('先重試');
 await page.getByRole('button',{name:'重試相同操作'}).click();await expect(page.locator('#status')).toContainText('預約已確認');expect(ids).toHaveLength(2);expect(ids[0]).toBe(ids[1]);await expect(page.getByRole('button',{name:'重新整理'})).toBeEnabled();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await info.attach('frontdesk-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
});
test('FRONTDESK_ADMIN — merchant grants are per person, default notify-only and unknown results freeze other writes',async({page})=>{
 await page.goto(base+'/frontdesk/');await page.setContent('<link rel="stylesheet" href="'+base+'/frontdesk/styles.css"><main id="root"></main>');
 await page.addScriptTag({url:base+'/admin/frontdesk-settings.js'});
 await page.evaluate(()=>{
  const staff=[{id:'a',displayName:'櫃檯 A',status:'pending',permissionMode:'notify_only',version:1},{id:'b',displayName:'櫃檯 B',status:'approved',permissionMode:'notify_only',version:1}];window.frontdeskAdminCalls=[];window.frontdeskLose=true;
  window.FrontdeskSettings.mount({root:document.getElementById('root'),business:'shop-a',request:async(action,body)=>{window.frontdeskAdminCalls.push({action,body});if(action==='platform.frontdesk.staff.save'){if(window.frontdeskLose){window.frontdeskLose=false;throw Object.assign(Error('無法確認結果'),{uncertain:true});}Object.assign(staff.find(x=>x.id===body.staffId),{status:body.status,permissionMode:body.permissionMode});}return{version:1,frontdesk:{},staff};}});
 });
 await page.locator('summary').click();const first=page.locator('.frontdesk-person').first(),second=page.locator('.frontdesk-person').nth(1);
 await expect(first.locator('[name=permissionMode]')).toHaveValue('notify_only');await first.locator('[name=permissionMode]').selectOption('review');await first.getByRole('button').click();await expect(second.getByRole('button')).toBeDisabled();await page.getByRole('button',{name:'重試相同儲存操作'}).click();
 await expect(page.locator('.frontdesk-person').first().locator('[name=permissionMode]')).toHaveValue('review');await expect(page.locator('.frontdesk-person').nth(1).locator('[name=permissionMode]')).toHaveValue('notify_only');
 const writes=await page.evaluate(()=>window.frontdeskAdminCalls.filter(x=>x.action==='platform.frontdesk.staff.save'));expect(writes).toHaveLength(2);expect(writes[0].body.requestId).toBe(writes[1].body.requestId);expect(writes[0].body.staffId).toBe('a');
});
test('FRONTDESK_SETTINGS_RETRY — lost first settings response replays the frozen original form',async({page})=>{
 await page.goto(base+'/frontdesk/');await page.setContent('<main id="root"></main>');await page.addScriptTag({url:base+'/admin/frontdesk-settings.js'});
 await page.evaluate(()=>{window.savedSettings=[];window.FrontdeskSettings.mount({root:document.getElementById('root'),business:'shop-a',request:async(action,body)=>{if(action==='platform.frontdesk.settings.save'){window.savedSettings.push(body);if(window.savedSettings.length===1)throw Object.assign(Error('無法確認結果'),{uncertain:true});return{version:2,frontdesk:body.settings,staff:[]};}return{version:1,frontdesk:{},staff:[]};}});});
 await page.locator('summary').click();await page.locator('[name=loginChannelId]').fill('2010999999');await page.locator('[name=liffId]').fill('2010999999-desk');await page.locator('[name=messagingChannelId]').fill('2010888888');await page.locator('[name=channelAccessToken]').fill('synthetic-token-without-provider-use');
 await page.getByRole('button',{name:'驗證並儲存櫃檯設定'}).click();await expect(page.getByRole('button',{name:'重試相同儲存操作'})).toBeVisible();await page.getByRole('button',{name:'重試相同儲存操作'}).click();await expect(page.locator('[role=status]')).toContainText('已儲存',{timeout:3000});
 const calls=await page.evaluate(()=>window.savedSettings);expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);
});
