const {test,expect}=require('playwright/test'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
let server,base;
test.beforeAll(async()=>{server=http.createServer((req,res)=>{
 const route=req.url.split('?')[0];
 if(route==='/business-context.js'){
  res.setHeader('Content-Type','text/javascript');
  return res.end("window.BusinessContext={slug:new URLSearchParams(location.search).get('business')||'',set:function(value){this.slug=value},configure:async function(base){return {...base,adminLiffId:'2010999999-manager'}}};");
 }
 if(route==='/member-system.js'){
  res.setHeader('Content-Type','text/javascript');
  return res.end("window.MemberSystem={validateConfig:()=>{}};");
 }
 if(route==='/config/config.json'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic-public'}));}
 const file={'/frontdesk/':'frontdesk/index.html','/frontdesk/app.js':'frontdesk/app.js','/frontdesk/theme-toggle.js':'frontdesk/theme-toggle.js','/theme.js':'theme.js','/frontdesk/styles.css':'frontdesk/styles.css','/frontdesk/workspace-polish.css':'frontdesk/workspace-polish.css','/admin/frontdesk-settings.js':'admin/frontdesk-settings.js','/theme.css':'theme.css','/theme.js':'theme.js',
 '/admin/frontdesk-settings/':'admin/frontdesk-settings/index.html',
 '/admin/frontdesk-settings/frontdesk-settings-page.js':'admin/frontdesk-settings/frontdesk-settings-page.js',
 '/admin/frontdesk-settings/frontdesk-settings-page.css':'admin/frontdesk-settings/frontdesk-settings-page.css'}[route];
 if(!file){res.statusCode=404;return res.end();}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(fs.readFileSync(path.resolve(__dirname,'../..',file)));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;});
test.afterAll(async()=>new Promise(resolve=>server.close(resolve)));
for(const width of [390,1280])test('FRONTDESK_'+width+' — notify-only, scoped review, downgrade and lost-response replay',async({page},info)=>{
 await page.emulateMedia({colorScheme:width===390?'dark':'light'});
 let mode='notify_only',status='pending',lose=false,downgrade=false;const calls=[],ids=[];
 await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:'dark'});
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:'window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>"verified-staff",login:()=>{},logout:()=>{}};'}));
 await page.route('https://fixture.supabase.co/**',async route=>{
  const b=route.request().postDataJSON();calls.push(b);expect(b.business).toBe('shop-a');let data;
  if(b.action==='frontdesk.public')data={name:'測試商家',frontdesk:{enabled:true,liffId:'2010999999-desk',oaId:'@desk'}};
  else if(b.action==='frontdesk.bootstrap')data={staff:{displayName:'櫃檯 A',status:'approved',permissionMode:mode}};
  else if(b.action==='frontdesk.sync.status')data={revision:'1'};
  else if(b.action==='frontdesk.bookings')data={bookings:status==='pending'?[{id:'10000000-0000-4000-8000-000000000001',status,updatedAt:'2026-11-18T12:00:00+08:00',name:'林小姐',phone:'0900000000',partySize:2,startAt:'2026-11-20T10:00:00',endAt:'2026-11-20T11:00:00',services:[{title:'測試服務',quantity:2}]}]:[]};
  else if(b.action==='frontdesk.booking.update'){
   if(downgrade){mode='notify_only';return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'FRONTDESK_REVIEW_REQUIRED',message:'你目前沒有確認或拒絕預約的權限。'}})});}
   ids.push(b.requestId);status=b.status;if(lose){lose=false;return route.abort('failed');}data={booking:{status},alreadyApplied:ids.length>1};
  }else throw Error('UNEXPECTED_ACTION '+b.action);
  await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
 });
 await page.goto(base+'/frontdesk/?business=shop-a');await expect(page.getByRole('link',{name:'加入櫃檯官方帳號'})).toHaveCount(0);await expect(page.locator('#themeToggleButton')).toBeVisible();if(width===390){await page.locator('#themeToggleButton').click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await expect(page.locator('#themeToggleButton')).toHaveAttribute('aria-label','切換為暗色調');await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','light');}await expect(page.locator('#account')).toContainText('僅接收預約訊息');await expect(page.locator('[data-review-action]')).toHaveCount(0);expect(calls.some(x=>x.action==='frontdesk.bookings')).toBe(false);if(width===390){const contrast=await page.locator('#themeToggleButton').evaluate(a=>{const rgb=s=>s.match(/\d+/g).slice(0,3).map(Number),luma=c=>c.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0);const x=luma(rgb(getComputedStyle(a).color)),y=luma(rgb(getComputedStyle(document.body).backgroundColor));return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);});expect(contrast).toBeGreaterThanOrEqual(4.5);}
 mode='review';await page.getByRole('button',{name:'重新整理'}).click();await expect(page.getByRole('button',{name:'確認預約',exact:true})).toBeVisible();await expect(page.locator('.frontdesk-card .frontdesk-badge')).toHaveText('待確認');await expect(page.locator('.frontdesk-card .frontdesk-time').last()).toContainText('10:00');await expect(page.locator('.frontdesk-card a[href^="tel:"]')).toHaveAttribute('href','tel:0900000000');await expect(page.locator('#progress')).toBeHidden();await info.attach('frontdesk-pending-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 page.once('dialog',dialog=>{expect(dialog.message()).toContain('確認預約');return dialog.dismiss();});
  await page.getByRole('button',{name:'確認預約',exact:true}).click();
  expect(status).toBe('pending');expect(ids).toHaveLength(0);
  page.on('dialog',dialog=>dialog.accept());
  downgrade=true;await page.getByRole('button',{name:'確認預約',exact:true}).click();await expect(page.locator('#account')).toContainText('僅接收預約訊息');await expect(page.locator('#status')).toContainText('沒有');expect(status).toBe('pending');
 downgrade=false;mode='review';await page.getByRole('button',{name:'重新整理'}).click();lose=true;await page.getByRole('button',{name:'確認預約',exact:true}).click();await expect(page.getByRole('button',{name:'重試相同操作'})).toBeVisible();
 await page.getByRole('button',{name:'拒絕預約',exact:true}).click();await expect(page.locator('[role=dialog]')).toHaveCount(0);expect(ids).toHaveLength(1);await expect(page.locator('#status')).toContainText('先重試');
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
 await expect(first.locator('[name=permissionMode]')).toHaveValue('notify_only');await first.locator('[name=permissionMode]').selectOption('review');await first.locator('button[type=submit]').click();await expect(second.locator('button[type=submit]')).toBeDisabled();await page.getByRole('button',{name:'重試相同儲存操作'}).click();
 await expect(page.locator('.frontdesk-person').first().locator('[name=permissionMode]')).toHaveValue('review');await expect(page.locator('.frontdesk-person').nth(1).locator('[name=permissionMode]')).toHaveValue('notify_only');
 const writes=await page.evaluate(()=>window.frontdeskAdminCalls.filter(x=>x.action==='platform.frontdesk.staff.save'));expect(writes).toHaveLength(2);expect(writes[0].body.requestId).toBe(writes[1].body.requestId);expect(writes[0].body.staffId).toBe('a');
});
test('FRONTDESK_SETTINGS_RETRY — lost first settings response replays the frozen original form',async({page})=>{
 await page.goto(base+'/frontdesk/');await page.setContent('<main id="root"></main>');await page.addScriptTag({url:base+'/admin/frontdesk-settings.js'});
 await page.evaluate(()=>{window.savedSettings=[];window.FrontdeskSettings.mount({root:document.getElementById('root'),business:'shop-a',request:async(action,body)=>{if(action==='platform.frontdesk.settings.save'){window.savedSettings.push(body);if(window.savedSettings.length===1)throw Object.assign(Error('無法確認結果'),{uncertain:true});return{version:2,frontdesk:body.settings,staff:[]};}return{version:1,frontdesk:{},staff:[]};}});});
 await page.locator('summary').click();await expect(page.locator('[name=loginChannelId]')).toBeVisible();await expect(page.locator('.frontdesk-settings a')).toHaveCount(0);await expect(page.locator('.frontdesk-setup-guide')).toHaveCount(0);await expect(page.getByRole('button',{name:'複製 Endpoint URL'})).toBeVisible();await page.locator('[name=loginChannelId]').fill('2010999999');await page.locator('[name=liffId]').fill('2010999999-desk');await page.locator('[name=messagingChannelId]').fill('2010888888');await page.locator('[name=channelAccessToken]').fill('synthetic-token-without-provider-use');
 await page.getByRole('button',{name:'驗證並儲存櫃檯設定'}).click();await expect(page.getByRole('button',{name:'重試相同儲存操作'})).toBeVisible();await page.getByRole('button',{name:'重試相同儲存操作'}).click();await expect(page.locator('[role=status]')).toContainText('已儲存',{timeout:3000});
 const calls=await page.evaluate(()=>window.savedSettings);expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);
});

test('FRONTDESK_APPLICANT — LINE user submits application; bookings remain unavailable until merchant approval',async({page})=>{
 const calls=[];let staffStatus=null,mode='notify_only';
 await page.setViewportSize({width:390,height:844});
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:'window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>"verified-staff",login:()=>{},logout:()=>{}};'}));
 await page.route('https://fixture.supabase.co/**',async route=>{
  const body=route.request().postDataJSON();calls.push(body.action);
  let data;
  if(body.action==='frontdesk.public')data={name:'商家測試',frontdesk:{enabled:true,liffId:'2010999999-desk',oaId:'@desk'}};
  else if(body.action==='frontdesk.bootstrap')data={staff:staffStatus?{displayName:'新進櫃檯',status:staffStatus,permissionMode:mode}:null};
  else if(body.action==='frontdesk.apply'){staffStatus='pending';data={staff:{status:'pending'}};}
  else if(body.action==='frontdesk.sync.status')data={revision:'1'};
  else if(body.action==='frontdesk.bookings')data={bookings:[{id:'10000000-0000-4000-8000-000000000001',status:'pending',updatedAt:'2026-11-18T12:00:00+08:00',services:[]}]};
  else throw Error('Unexpected action '+body.action);
  await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
 });
 await page.goto(base+'/frontdesk/?business=shop-a');
 await expect(page.getByRole('button',{name:'送出櫃檯人員申請'})).toBeVisible();
 await expect(page.locator('#progress li[data-state=current]')).toContainText('申請櫃檯資格');
 await expect(page.locator('.frontdesk-toolbar h2')).toBeHidden();
 expect(calls).not.toContain('frontdesk.bookings');
 await page.getByRole('button',{name:'送出櫃檯人員申請'}).click();
 await expect(page.locator('#account')).toContainText('等待商家管理員審核');
 await expect(page.locator('#progress li[data-state=current]')).toContainText('管理員審核');
 expect(calls).not.toContain('frontdesk.bookings');
 staffStatus='approved';
 await page.getByRole('button',{name:'重新整理'}).click();
 await expect(page.locator('#account')).toContainText('僅接收預約訊息');
 await expect(page.locator('.frontdesk-toolbar h2')).toBeHidden();
 expect(calls).not.toContain('frontdesk.bookings');
 mode='review';
 await page.getByRole('button',{name:'重新整理'}).click();
 await expect(page.getByRole('button',{name:'確認預約'})).toBeVisible();
 expect(calls.filter(x=>x==='frontdesk.apply')).toHaveLength(1);
 expect(calls.filter(x=>x==='frontdesk.bookings').length).toBeGreaterThanOrEqual(1); // Initial authorized load plus revision reconciliation are both valid.
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('FRONTDESK_CONFIG_GUIDE — LINE sources, notification-card parity and automatic LIFF channel extraction',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto(base+'/frontdesk/');
 await page.setContent('<link rel="stylesheet" href="'+base+'/frontdesk/styles.css"><main id="root"></main>');
 await page.addScriptTag({url:base+'/admin/frontdesk-settings.js'});
 await page.evaluate(()=>window.FrontdeskSettings.mount({
  root:document.getElementById('root'),business:'shop-a',
  request:async()=>({version:1,frontdesk:{},staff:[{id:'pending',displayName:'待審櫃檯',status:'pending',permissionMode:'notify_only',version:1}]})
 }));
 await page.locator('summary').click();
 await expect(page.locator('.frontdesk-notification-card legend')).toHaveText('2. 預約通知');
 await expect(page.locator('.business-notification-toggle')).toHaveCount(1);
 await expect(page.locator('.business-line-summary')).toContainText(['尚未設定櫃檯官方帳號','待審核 1 人']);
 await expect(page.locator('#root')).toContainText('LINE Developers → LINE Login Channel → LIFF');
 await expect(page.locator('#root')).toContainText('LINE Official Account Manager');
 await expect(page.locator('.frontdesk-endpoint')).toHaveText(base+'/frontdesk/?business=shop-a');
 await page.locator('[name=liffId]').fill('https://liff.line.me/2010999999-desk');
 await page.locator('[name=liffId]').press('Tab');
 await expect(page.locator('[name=liffId]')).toHaveValue('2010999999-desk');
 await expect(page.locator('[name=loginChannelId]')).toHaveValue('2010999999');
 await expect(page.locator('.frontdesk-person [name=permissionMode]')).toHaveValue('notify_only');
 await expect(page.locator('.frontdesk-person')).toContainText('待審核');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('FRONTDESK_SETTINGS_THEME — explicit merchant light/dark palette overrides OS preference',async({page},info)=>{
 await page.setViewportSize({width:390,height:844});
 await page.emulateMedia({colorScheme:'dark'});
 await page.goto(base+'/frontdesk/');
 await page.setContent('<link rel="stylesheet" href="'+base+'/theme.css"><link rel="stylesheet" href="'+base+'/frontdesk/styles.css"><main id="root"></main>');
 await page.addScriptTag({url:base+'/admin/frontdesk-settings.js'});
 await page.evaluate(()=>window.FrontdeskSettings.mount({
  root:document.getElementById('root'),business:'shop-a',
  request:async()=>({version:1,frontdesk:{},staff:[]})
 }));
 await page.locator('summary').click();
 await expect(page.locator('[name="liffId"]')).toBeVisible();
 const sample=async(theme)=>{
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  return page.locator('.frontdesk-settings').evaluate(el=>{
   const style=getComputedStyle(el),input=getComputedStyle(el.querySelector('input'));
   return {card:style.backgroundColor,text:style.color,inputBackground:input.backgroundColor,
     primary:style.getPropertyValue('--fd-primary').trim(),
     expectedPrimary:style.getPropertyValue('--ui-primary').trim(),
     onPrimary:style.getPropertyValue('--fd-on-primary').trim()};
  });
 };
 const light=await sample('light');
 expect(light.primary).toBe(light.expectedPrimary);
 await info.attach('frontdesk-settings-light',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 const dark=await sample('dark');
 expect(dark.primary).toBe(dark.expectedPrimary);
 expect(dark.card).not.toBe(light.card);
 expect(dark.text).not.toBe(light.text);
 expect(dark.inputBackground).not.toBe(light.inputBackground);
 expect(dark.onPrimary).not.toBe(light.onPrimary);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await info.attach('frontdesk-settings-dark',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
});

for(const width of [390,1280])test('FRONTDESK_SETTINGS_STANDALONE_'+width+' — separate page checks merchant grant and clears on revocation',async({page},info)=>{
 await page.setViewportSize({width,height:900});
 const calls=[];
 let granted=true, applicant=false;
 await page.clock.install();
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({
  contentType:'text/javascript',
  body:'window.liff={init:async()=>{},isLoggedIn:()=>true,isInClient:()=>true,getIDToken:()=>"synthetic-admin-token",login:()=>{},logout:()=>{}};'
 }));
 await page.route('https://fixture.supabase.co/**',route=>{
  const input=route.request().postDataJSON();calls.push(input);
  expect(input.business).toBe('shop-a');
  expect(input.idToken).toBe('synthetic-admin-token');
  const data=input.action==='platform.application.bootstrap'
   ? {application:{status:'approved'},tenant:{name:'測試商家',slug:'shop-a',status:'active',expired:false,onboarding:{adminReady:true},features:{booking:true,frontdesk:granted}}}
   :input.action==='platform.frontdesk.get'
   ? {version:1,frontdesk:{enabled:true,liffId:'2010999999-desk',loginChannelId:'2010999999',messagingChannelId:'2010888888'},staff:applicant?[{id:'staff-new',version:1,status:'pending',displayName:'新申請櫃檯',permissionMode:'notify_only'}]:[]}
   :null;
  if(!data)throw Error('UNEXPECTED_ACTION '+input.action);
  return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
 });
 await page.goto(base+'/admin/frontdesk-settings/?business=shop-a');
 await expect(page.locator('h1')).toHaveText('櫃檯設定');
 await expect(page.locator('#frontdeskPageContent')).toBeVisible();
 await expect(page.locator('#frontdeskSettingsRoot [data-frontdesk-settings]')).toBeVisible();
 await expect(page.locator('#adminView,#merchantWorkspace,#productizedAdmin,#frontdeskSettingsTab')).toHaveCount(0);
 await expect(page.locator('#frontdeskManageBusiness')).toHaveAttribute('href','/admin/?business=shop-a');
 // AC-001/002: geometry in Chromium, not just DOM order. The LINE section
 // stays a single document flow while its two setup cards share a desktop row.
 const lineFlow=await page.evaluate(()=>{
  const rect=selector=>{
   const element=document.querySelector(selector);
   if(!element)throw Error('Missing LINE layout component '+selector);
   const b=element.getBoundingClientRect();
   return {top:b.top,bottom:b.bottom,left:b.left,right:b.right};
  };
  return {
   login:rect('.frontdesk-config-form > fieldset:first-of-type'),
   notification:rect('.frontdesk-config-form > fieldset:nth-of-type(2)'),
   save:rect('.frontdesk-config-form > button[type="submit"]'),
   title:rect('.frontdesk-preferences-form'),
   staff:rect('.frontdesk-approvals'),
   viewport:innerWidth,pageWidth:document.documentElement.scrollWidth
  };
 });
 expect(lineFlow.pageWidth).toBeLessThanOrEqual(lineFlow.viewport+1);
 if(width===1280){
  expect(Math.abs(lineFlow.login.top-lineFlow.notification.top)).toBeLessThanOrEqual(2);
  expect(lineFlow.login.right).toBeLessThan(lineFlow.notification.left);
 }else{
  expect(lineFlow.notification.top).toBeGreaterThanOrEqual(lineFlow.login.bottom-1);
 }
 expect(lineFlow.save.top).toBeGreaterThanOrEqual(Math.max(lineFlow.login.bottom,lineFlow.notification.bottom)-1);
 expect(lineFlow.title.top).toBeGreaterThanOrEqual(lineFlow.save.bottom-1);
 expect(lineFlow.staff.top).toBeGreaterThanOrEqual(lineFlow.title.bottom-1);

 expect(calls.some(c=>c.action==='platform.application.bootstrap')).toBe(true);
 expect(calls.some(c=>c.action==='platform.frontdesk.get')).toBe(true);
 // The explicit app theme, not OS color preference, owns every standalone color.
 await page.emulateMedia({colorScheme:'dark'});
 const palette=[];
 for(const theme of ['light','dark']){
  // Exercise the real theme controller: a raw dataset mutation bypasses the
  // persisted preference and can race its OS media-change listener.
  await page.evaluate(theme=>window.LumenTheme.set(theme),theme);
  await expect(page.locator('#themeToggleButton')).toHaveAttribute('aria-pressed',String(theme==='dark'));
  const sample=await page.evaluate(()=>{
   const rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(Number);
   const luminance=color=>rgb(color).map(x=>{
    x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;
   }).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
   const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
   const shell=getComputedStyle(document.querySelector('.frontdesk-settings-standalone'));
   const form=getComputedStyle(document.querySelector('.frontdesk-settings-content'));
   const input=getComputedStyle(document.querySelector('[name=liffId]'));
   const save=getComputedStyle(document.querySelector('.frontdesk-config-form button[type=submit]'));
   const headings=getComputedStyle(document.querySelector('#frontdeskPageHeading'));
   const pageStatus=getComputedStyle(document.querySelector('#frontdeskPageStatus'));
   return{
    primary:shell.getPropertyValue('--fd-primary').trim(),
    expectedPrimary:shell.getPropertyValue('--ui-primary').trim(),
    background:getComputedStyle(document.body).backgroundColor,
    fieldBackground:input.backgroundColor,
    columns:form.gridTemplateColumns.split(' ').length,
    saveContrast:contrast(save.color,save.backgroundColor),
    titleContrast:contrast(headings.color,getComputedStyle(document.querySelector('.frontdesk-page-header')).backgroundColor),
    statusContrast:contrast(pageStatus.color,pageStatus.backgroundColor),
    overflows:document.documentElement.scrollWidth>innerWidth
   };
  });
  expect(sample.primary).toBe(sample.expectedPrimary);
  expect(sample.columns).toBe(1); // One stable LINE flow; two cards may share a row only inside its form.
  expect(sample.saveContrast).toBeGreaterThanOrEqual(4.5);
  expect(sample.titleContrast).toBeGreaterThanOrEqual(4.5);
  expect(sample.statusContrast).toBeGreaterThanOrEqual(4.5);
  expect(sample.overflows).toBe(false);
  palette.push(sample);
  await info.attach('frontdesk-settings-layout-'+width+'-'+theme,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }
 expect(palette[0].background).not.toBe(palette[1].background);
 expect(palette[0].fieldBackground).not.toBe(palette[1].fieldBackground);

 // Simulate remote staff application without same-browser broadcast or focus.
 applicant=true;
 await page.clock.fastForward(16000);
 await expect(page.locator('.frontdesk-person')).toHaveCount(1);
 await expect(page.locator('.frontdesk-person')).toContainText('新申請櫃檯');
 // Revocation must purge the previously visible settings, not merely hide buttons.
 granted=false;
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.locator('#frontdeskPageContent')).toBeHidden();
 await expect(page.locator('#frontdeskSettingsRoot [data-frontdesk-settings]')).toHaveCount(0);
 await expect(page.locator('#frontdeskPageGate')).toBeVisible();
 await expect(page.locator('#frontdeskPageStatus')).toContainText('尚未獲得櫃檯設定授權');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});


test('FRONTDESK_SETTINGS_RESUME — verify access once before reading settings', async ({ page }) => {
 const bootstrap = 'platform.application.bootstrap';
 const getSettings = 'platform.frontdesk.get';
 const access = Promise.withResolvers();
 const settingsStarted = Promise.withResolvers();
 const settingsResponse = Promise.withResolvers();
 let applicant = false;
 await page.addInitScript(() => {
  const fetchOriginal = window.fetch.bind(window);
  window.settingsActions = [];
  window.fetch = (url, options) => {
   if (String(url).startsWith('https://fixture.supabase.co/')) {
    window.settingsActions.push(JSON.parse(options.body).action);
   }
   return fetchOriginal(url, options);
  };
 });
 await page.route('https://static.line-scdn.net/**', route => route.fulfill({
  contentType: 'text/javascript',
  body: 'window.liff={init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>"synthetic-admin-token"};'
 }));
 let resuming = false;
 await page.route('https://fixture.supabase.co/**', async route => {
  const { action, business, idToken } = route.request().postDataJSON();
  expect(business).toBe('shop-a');
  expect(idToken).toBe('synthetic-admin-token');
  let data;
  if (action === bootstrap) {
   if (resuming) await access.promise;
   data = { application: { status: 'approved' }, tenant: {
    name: '測試商家', slug: 'shop-a', status: 'active', expired: false,
    onboarding: { adminReady: true }, features: { booking: true, frontdesk: true }
   } };
  } else if (action === getSettings) {
   const staff = applicant ? [{ id: 'staff-new', version: 1, status: 'pending', displayName: '新申請櫃檯' }] : [];
   if (applicant) {
    settingsStarted.resolve();
    await settingsResponse.promise;
   }
   data = { version: 1, frontdesk: {}, staff };
  } else throw Error('UNEXPECTED_ACTION ' + action);
  await route.fulfill({ json: { ok: true, data } });
 });
 await page.goto(base + '/admin/frontdesk-settings/?business=shop-a');
 await expect(page.getByText('目前沒有申請。', { exact: false })).toBeVisible();
 const reload = page.getByRole('button', { name: '重新整理', exact: true });
 const resume = () => {
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  document.dispatchEvent(new Event('visibilitychange'));
  return window.settingsActions.slice();
 };
 resuming = true;
 try {
  await page.evaluate(() => { window.settingsActions.length = 0; });
  const beforeAccess = await page.evaluate(resume);
  // Let any premature read finish so the request count includes the second
  // read the old implementation starts once the access check succeeds.
  if (beforeAccess.includes(getSettings)) await expect(reload).toBeEnabled();
  applicant = true;
  access.resolve();
  await settingsStarted.promise;
  const afterAccess = await page.evaluate(() => window.settingsActions.slice());
  const duringRead = await page.evaluate(resume);
  settingsResponse.resolve();
  await expect(page.locator('.frontdesk-person')).toContainText('新申請櫃檯');
  expect(afterAccess).toEqual([bootstrap, getSettings]);
  expect(duringRead).toEqual(afterAccess);
  expect(beforeAccess).toEqual([bootstrap]);
 } finally {
  access.resolve();
  settingsResponse.resolve();
 }
});

test('FRONTDESK_SETTINGS_EXTERNAL_SESSION — reuse an existing external LINE login without redirect',async({page})=>{
 const calls=[];
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:"window.__lineActions=[];window.__sessionLoggedOut=false;window.liff={init:async()=>{},isLoggedIn:()=>!window.__sessionLoggedOut,isInClient:()=>false,getIDToken:()=>window.__sessionLoggedOut?'':'synthetic-admin-token',logout:()=>{window.__sessionLoggedOut=true;window.__lineActions.push('logout')},login:()=>window.__lineActions.push('login')};"}));
 await page.route('https://fixture.supabase.co/**',route=>{
  const input=route.request().postDataJSON();calls.push(input);
  expect(input.idToken).toBe('synthetic-admin-token');expect(input.business).toBe('shop-a');
  const data=input.action==='platform.application.bootstrap'
   ? {application:{status:'approved'},tenant:{name:'測試商家',slug:'shop-a',status:'active',expired:false,onboarding:{adminReady:true},features:{booking:true,frontdesk:true}}}
   : input.action==='platform.frontdesk.get'
   ? {version:1,frontdesk:{enabled:true,liffId:'2010999999-desk',loginChannelId:'2010999999',messagingChannelId:'2010888888'},staff:[]}
   : null;
  if(!data)throw Error('UNEXPECTED_ACTION '+input.action);
  return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
 });
 await page.goto(base+'/admin/frontdesk-settings/?business=shop-a');
 await expect(page.locator('#frontdeskPageContent')).toBeVisible();
 expect(await page.evaluate(()=>window.__lineActions)).toEqual([]);
 expect(calls.filter(x=>x.action==='platform.application.bootstrap')).toHaveLength(1);
 expect(calls.some(x=>x.action==='platform.frontdesk.get')).toBe(true);
 await expect(page.locator('#frontdeskMerchantTitle')).toHaveText('測試商家');
});

test('FRONTDESK_SETTINGS_MANUAL_REAUTH — rejected token never grants access and re-login requires an explicit click',async({page})=>{
 let bootstrapCalls=0;
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:"window.__lineActions=[];window.liff={init:async()=>{},isLoggedIn:()=>true,isInClient:()=>false,getIDToken:()=>'expired-admin-token',logout:()=>window.__lineActions.push('logout'),login:()=>window.__lineActions.push('login')};"}));
 await page.route('https://fixture.supabase.co/**',route=>{
  const input=route.request().postDataJSON();bootstrapCalls++;
  expect(input.action).toBe('platform.application.bootstrap');
  return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'AUTH_INVALID',message:'登入已失效'}})});
 });
 await page.goto(base+'/admin/frontdesk-settings/?business=shop-a');
 await expect(page.locator('#frontdeskPageGate')).toBeVisible();
 await expect(page.locator('#frontdeskPageContent')).toBeHidden();
 expect(bootstrapCalls).toBe(1);
 expect(await page.evaluate(()=>window.__lineActions)).toEqual([]);
 await page.locator('#frontdeskPageLogin').click();
 await expect.poll(()=>page.evaluate(()=>window.__lineActions)).toEqual(['logout','login']);
 expect(bootstrapCalls).toBe(1);
 await expect(page.locator('#frontdeskPageContent')).toBeHidden();
});

test('FRONTDESK_STAFF_DELETE — real browser confirms deletion, cancels safely and shows empty state',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto(base+'/frontdesk/');
 await page.setContent('<link rel="stylesheet" href="'+base+'/theme.css"><main id="root"></main>');
 await page.addScriptTag({url:base+'/admin/frontdesk-settings.js'});
 await page.evaluate(()=>{
  window.frontdeskDeleteCalls=[];
  let firstDeleteResponseLost=true;
  let staff=[{id:'10000000-0000-4000-8000-000000000006',displayName:'待移除櫃檯',status:'approved',permissionMode:'review',version:3}];
  window.FrontdeskSettings.mount({root:document.getElementById('root'),business:'shop-a',request:async(action,body)=>{
    window.frontdeskDeleteCalls.push({action,body});
    if(action==='platform.frontdesk.staff.delete'){
      if(body.staffId!==staff[0]?.id||body.expectedVersion!==3)throw Error('unexpected staff identity');
      if(firstDeleteResponseLost){firstDeleteResponseLost=false;throw Object.assign(Error('模擬第一次回應遺失'),{uncertain:true});}
      staff=[];return{version:2,frontdesk:{},staff};
    }
    if(action!=='platform.frontdesk.get')throw Error('unknown action '+action);
    return{version:2,frontdesk:{},staff};
  }});
 });
 await page.locator('summary').click();
 const remove=page.getByRole('button',{name:'移除 待移除櫃檯 的櫃檯帳號'});
 await expect(remove).toBeVisible();
 page.once('dialog',dialog=>dialog.dismiss());
 await remove.click();
 expect(await page.evaluate(()=>window.frontdeskDeleteCalls.filter(c=>c.action==='platform.frontdesk.staff.delete').length)).toBe(0);
 await expect(remove).toBeVisible();
 page.once('dialog',dialog=>{expect(dialog.message()).toContain('必須重新提出申請');return dialog.accept();});
 await remove.click();
 const retry=page.getByRole('button',{name:'重試相同儲存操作'});
 await expect(retry).toBeEnabled();
 await expect(page.locator('.frontdesk-person button[type=submit]')).toBeDisabled();
 await retry.click();
 await expect(page.locator('.frontdesk-person')).toHaveCount(0);
 await expect(page.locator('#root')).toContainText('目前沒有申請');
 await expect(page.locator('[role=status]')).toContainText('須重新申請並審核');
 const sent=await page.evaluate(()=>window.frontdeskDeleteCalls.filter(c=>c.action==='platform.frontdesk.staff.delete'));
 expect(sent).toHaveLength(2);
 expect(sent[0].body).toEqual(sent[1].body);
 expect(sent[0].body.staffId).toBe('10000000-0000-4000-8000-000000000006');
 expect(sent[0].body.expectedVersion).toBe(3);
 expect(sent[0].body.requestId).toMatch(/^[0-9a-f-]{36}$/);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});


test('AC-FD-RT-001: member booking appears without manual refresh; authorization revocation closes synchronization',async({page})=>{
 let revision=1,approved=true,bookingCount=0,failNextBooking=false;const calls=[];
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:'window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>"verified-staff",login:()=>{},logout:()=>{}};'}));
 await page.route('https://fixture.supabase.co/**',route=>{
  const input=route.request().postDataJSON();calls.push(input.action);
  if(input.action==='frontdesk.bookings'&&failNextBooking){
   failNextBooking=false;
   return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'TEMPORARY_UNAVAILABLE',message:'預約資料暫時無法取得。'}})});
  }
  if(input.action==='frontdesk.sync.status'&&!approved){
   return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'FRONTDESK_REVIEW_REQUIRED',message:'已撤銷櫃檯權限。'}})});
  }
  const data=input.action==='frontdesk.public'
   ? {name:'測試商家',frontdesk:{enabled:true,liffId:'2010999999-desk'}}
   :input.action==='frontdesk.bootstrap'
   ? {staff:{displayName:'審核櫃檯',status:'approved',permissionMode:'review'}}
   :input.action==='frontdesk.sync.status'
   ? {revision:String(revision)}
   :input.action==='frontdesk.bookings'
   ? {bookings:bookingCount?[{id:'10000000-0000-4000-8000-000000000001',status:'pending',updatedAt:'2026-11-20T12:00:00+08:00',bookingDate:'2026-11-21',startTime:'09:30',name:'林先生',phone:'0900000000',partySize:1,participants:[{position:1,services:[{title:'身體60',quantity:1}],technician:'10技師'}]}]:[]}
   :null;
  if(!data)throw Error('Unexpected action '+input.action);
  return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
 });
 await page.goto(base+'/frontdesk/?business=shop-a');
 await expect(page.locator('#bookings')).toContainText('目前沒有待處理的預約');
 await expect.poll(()=>calls.filter(x=>x==='frontdesk.sync.status').length,{timeout:10000}).toBeGreaterThan(0);
 bookingCount=1;failNextBooking=true;revision++;
 await expect(page.locator('#status')).toContainText('同步暫時中斷',{timeout:12000});
 await expect(page.locator('#bookings')).toContainText('林先生',{timeout:20000});
 await expect(page.locator('#bookings')).toContainText('10技師');
 await expect(page.locator('#bookings')).toContainText('身體60');
 expect(calls.filter(x=>x==='frontdesk.bookings').length).toBeGreaterThan(1);
 approved=false;revision++;
 await expect(page.locator('#status')).toContainText('已撤銷櫃檯權限',{timeout:12000});
 await expect(page.locator('.frontdesk-card')).toHaveCount(0);
 const after=calls.filter(x=>x==='frontdesk.sync.status').length;
 await page.waitForTimeout(3400);
 expect(calls.filter(x=>x==='frontdesk.sync.status').length).toBe(after);
});

for(const width of [390,1280])test('FRONTDESK_REJECTION_MODAL_'+width+' — on-site reason reveals direct total duration and fixed original date',async({page})=>{
 await page.setViewportSize({width,height:880});await page.emulateMedia({colorScheme:width===390?'dark':'light'});
 const bookingId='10000000-0000-4000-8000-000000000011';
 let state='pending';const calls=[];
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({contentType:'text/javascript',body:'window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>"verified-staff",login:()=>{},logout:()=>{}};'}));
 await page.route('https://fixture.supabase.co/**',async route=>{
  const body=route.request().postDataJSON();calls.push(body);let data;
  if(body.action==='frontdesk.public')data={name:'QA商家',frontdesk:{enabled:true,liffId:'2010999999-desk',pageTitle:'QA 櫃檯',conflictStartMin:600,conflictStartMax:720,conflictDurationMin:30,conflictDurationMax:180}};
  else if(body.action==='frontdesk.bootstrap')data={staff:{displayName:'測試櫃檯',status:'approved',permissionMode:'review'}};
  else if(body.action==='frontdesk.bookings')data={bookings:state==='pending'?[{id:bookingId,status:'pending',updatedAt:'2026-11-20T10:00:00.000Z',bookingDate:'2026-12-12',startTime:'11:00',endTime:'12:00',totalDurationMinutes:60,name:'QA先生',phone:'0900111222',services:[]}]:[]};
  else if(body.action==='frontdesk.sync.status')data={revision:'1'};
  else if(body.action==='frontdesk.booking.reject-phone'){state='rejected';data={booking:{status:'rejected'},phoneBookingStatus:'confirmed',phoneBookingId:'10000000-0000-4000-8000-000000000014'};}
  else if(body.action==='frontdesk.history')data={items:[{actionAt:'2026-12-12T03:30:00Z',
    booking:{id:bookingId,status:'rejected',bookingDate:'2026-12-12',startTime:'11:00',endTime:'12:00',totalDurationMinutes:60,name:'QA先生',phone:'0900111222',partySize:1},
    phoneBooking:{id:'10000000-0000-4000-8000-000000000014',status:'confirmed',bookingDate:'2026-12-12',startTime:'11:00',endTime:'12:30',totalDurationMinutes:90}},
   {actionAt:'2026-12-12T03:45:00Z',booking:{id:'10000000-0000-4000-8000-000000000012',status:'rejected',name:'其他訂單不可顯示',phone:'0900999888'},phoneBooking:{id:'10000000-0000-4000-8000-000000000015',status:'confirmed',totalDurationMinutes:60}}]};
  else throw Error('Unexpected frontdesk action '+body.action);
  await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
 });
 await page.goto(base+'/frontdesk/?business=shop-a');
 await page.getByRole('button',{name:'拒絕預約',exact:true}).click();
 await expect(page.locator('#businessName')).toHaveText('QA 櫃檯');
 const modal=page.locator('[role=dialog]'),phone=modal.locator('[data-phone-registration]');
 await expect(modal).toBeVisible();await expect(phone).toBeHidden();
 await expect(modal.getByRole('button',{name:'確認拒絕預約'})).toBeDisabled();
 await modal.locator('[aria-label="選擇拒絕預約原因"]').selectOption('technician_leave');
 await expect(phone).toBeHidden();
 expect(calls.filter(x=>x.action==='frontdesk.phone.catalog')).toHaveLength(0);
 await modal.getByRole('button',{name:'取消',exact:true}).click();
 await expect(modal).toHaveCount(0);
 await page.getByRole('button',{name:'拒絕預約',exact:true}).click();
 await modal.locator('[aria-label="選擇拒絕預約原因"]').selectOption('unrecorded_phone_booking');
 await expect(phone).toBeVisible();
 await expect(phone.locator('.frontdesk-phone-date')).toContainText('2026-12-12');
  await expect(phone).toContainText('無須等待管理員審核');
 await expect(modal.locator('.frontdesk-original-booking')).toContainText('原預約時間：11:00 – 12:00');
 await expect(modal.locator('.frontdesk-original-booking')).toContainText('原預約總時長：60 分鐘');
 await expect(phone.locator('input[type="date"]')).toHaveCount(0);
 await expect(phone.locator('.frontdesk-phone-service-option')).toHaveCount(0);
 const duration=phone.getByRole('combobox',{name:'衝突預約總時長'});
 await expect(duration).toHaveValue('60');
 await expect(duration.locator('option')).toHaveCount(143);
 await expect(duration.locator('option[value="0"]')).toHaveCount(0);
 await expect(duration.locator('option[value="1430"]')).toHaveCount(1);
 await duration.selectOption('90');
 await expect(modal.getByRole('button',{name:'確認拒絕並登記現場預約'})).toBeEnabled();
 const time=phone.getByRole('combobox',{name:'衝突預約時間'});
 await expect(time).toHaveValue('11:00');
 await expect(time.locator('option')).toHaveCount(7);
 expect(await time.locator('option').evaluateAll(nodes=>nodes.map(n=>n.value)))
   .toEqual(['11:00','11:10','11:20','11:30','11:40','11:50','12:00']);
 await expect(time.locator('option[value="10:50"]')).toHaveCount(0);
 await expect(time.locator('option[value="12:10"]')).toHaveCount(0);
 // AC-WALKIN-WINDOW-001/003: original closing boundary counts as conflict.
 await time.selectOption('12:00');
 await expect(modal.getByRole('button',{name:'確認拒絕並登記現場預約'})).toBeEnabled();
 await expect(modal.locator('.frontdesk-phone-message')).toBeEmpty();
 // Simulate an out-of-range clock value without adding an allowed <option>.
 await time.evaluate(select=>{select.value='12:10';select.dispatchEvent(new Event('change',{bubbles:true}));});
 await expect(modal.getByRole('button',{name:'確認拒絕並登記現場預約'})).toBeDisabled();
 expect(calls.filter(x=>x.action==='frontdesk.booking.reject-phone')).toHaveLength(0);
 // Restore the original closing boundary. A forged or empty time cannot submit.
 await time.selectOption('11:30');
 await expect(modal.getByRole('button',{name:'確認拒絕並登記現場預約'})).toBeEnabled();
 await expect(modal.locator('.frontdesk-phone-message')).toBeEmpty();
 await time.selectOption('11:00');
 await expect(phone).toContainText('開始時間只顯示原預約區間內每 10 分鐘的選項');
 const box=await modal.evaluate(el=>({width:el.getBoundingClientRect().width,viewport:innerWidth,modalBackground:getComputedStyle(el).backgroundColor}));
 expect(box.width).toBeLessThanOrEqual(box.viewport);
 page.once('dialog',dialog=>{expect(dialog.message()).toContain('現場預約');return dialog.dismiss();});
  await modal.getByRole('button',{name:'確認拒絕並登記現場預約'}).click();
  expect(calls.filter(x=>x.action==='frontdesk.booking.reject-phone')).toHaveLength(0);
  page.once('dialog',dialog=>dialog.accept());
  await modal.getByRole('button',{name:'確認拒絕並登記現場預約'}).click();
 await expect(page.locator('#status')).toContainText('已登記並直接確認');
  await expect(page.locator('#status')).not.toContainText('等待管理員確認');
 const paired=calls.filter(x=>x.action==='frontdesk.booking.reject-phone');
 expect(paired).toHaveLength(1);
 expect(paired[0]).toMatchObject({bookingId,startTime:'11:00',rejectionReason:'unrecorded_phone_booking',totalDurationMinutes:90});
 expect(Object.hasOwn(paired[0],'items')).toBe(false);
 expect(calls.filter(x=>x.action==='frontdesk.phone.catalog')).toHaveLength(0);
 expect(Object.hasOwn(paired[0],'bookingDate')).toBe(false);
 expect(calls.filter(x=>x.action==='frontdesk.phone.create')).toHaveLength(0);
 await expect(page.locator('#frontdeskConflictHistory')).toBeVisible();
 await expect(page.locator('#frontdeskConflictHistory')).toContainText('原預約資料');
 await expect(page.locator('#frontdeskConflictHistory')).toContainText('櫃檯新增的衝突預約');
 await expect(page.locator('#frontdeskConflictHistory')).toContainText('總時長：90 分鐘');
 await expect(page.locator('#frontdeskConflictHistory')).toContainText('0900111222');
 await expect(page.locator('.frontdesk-history-pair')).toHaveCount(2,'ordinary workspace retains the staff-wide audit view');
 expect(calls.filter(x=>x.action==='frontdesk.history').every(x=>x.bookingId===undefined)).toBe(true);
 await page.goto(base+'/frontdesk/?business=shop-a&bookingId='+bookingId);
 await expect(page.locator('#frontdeskHistoryHeading')).toHaveText('本筆預約處理紀錄');
 await page.getByRole('button',{name:'查看／更新紀錄'}).click();
 await expect(page.locator('.frontdesk-history-pair')).toHaveCount(1);
 await expect(page.locator('#frontdeskConflictHistory')).toContainText('QA先生');
 await expect(page.locator('#frontdeskConflictHistory')).not.toContainText('其他訂單不可顯示');
 await expect(page.locator('#frontdeskConflictHistory')).not.toContainText('0900999888');
 expect(calls.filter(x=>x.action==='frontdesk.history').at(-1).bookingId).toBe(bookingId);
 await page.reload();
 await page.getByRole('button',{name:'查看／更新紀錄'}).click();
 await expect(page.locator('.frontdesk-history-pair')).toHaveCount(1);
 await expect(page.locator('#frontdeskConflictHistory')).toContainText('櫃檯新增的衝突預約');
 expect(calls.filter(x=>x.action==='frontdesk.history').at(-1).bookingId).toBe(bookingId);
});

for(const width of [390,1280])test('FRONTDESK_SETTINGS_HISTORY_'+width+' — standalone manager reads scoped confirm and reject histories in real Chromium',async({page},info)=>{
 await page.setViewportSize({width,height:900});
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({
  contentType:'text/javascript',
  body:'window.liff={init:async()=>{},isLoggedIn:()=>true,isInClient:()=>true,getIDToken:()=>"synthetic-manager",login:()=>{},logout:()=>{}};'
 }));
 const calls=[];
 await page.route('https://fixture.supabase.co/**',route=>{
  const body=route.request().postDataJSON();
  calls.push(body);
  expect(body.business).toBe('shop-a');
  expect(body.idToken).toBe('synthetic-manager');
  const confirmed=body.status==='confirmed';
  let data;
  if(body.action==='platform.application.bootstrap')
   data={application:{status:'approved'},tenant:{name:'測試商家',slug:'shop-a',status:'active',
     expired:false,onboarding:{adminReady:true},features:{booking:true,frontdesk:true}}};
  else if(body.action==='platform.frontdesk.get')
   data={version:1,frontdesk:{enabled:true,loginChannelId:'2010999999',
     liffId:'2010999999-desk',messagingChannelId:'2010888888'},staff:[]};
  else if(body.action==='platform.frontdesk.history.list')
   data={status:body.status,items:[{
    eventId:confirmed?1:2,bookingId:'10000000-0000-4000-8000-000000000009',
    actionAt:'2026-11-20T01:30:00Z',actorName:'櫃檯甲',rejectionReason:confirmed?null:'unrecorded_phone_booking',
    currentStatus:confirmed?'confirmed':'rejected',booking:{
     bookingDate:'2026-11-20',startTime:'09:30',endTime:'10:30',
     name:'測試會員',phone:'+886900000000',partySize:1,
     participants:[{position:1,technician:'10技師',note:'請加強肩頸',
       services:[{title:'身體60',quantity:1}]}]
    },phoneBooking:confirmed?null:{
     bookingDate:'2026-11-20',startTime:'10:30',endTime:'11:30',
     name:'櫃檯人員',phone:'',partySize:1,services:[{title:'身體60',quantity:1}]
    }
   }]};
  else throw Error('Unexpected action '+body.action);
  return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
 });
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/admin/frontdesk-settings/?business=shop-a');
 const section=page.locator('#frontdeskSettingsRoot');
 await expect(section.getByRole('tab')).toHaveCount(3);
 await expect(section.getByRole('tab',{name:'LINE 設定'})).toHaveAttribute('aria-selected','true');
 // AC-FD-LAYOUT-001/002: both panels must occupy the same stable grid track.
 // Real Chromium geometry catches <details> internal content-box regressions
 // that JSDOM cannot model. Repeat in light/dark and mobile/desktop.
 const layout=selector=>section.evaluate((root,name)=>{
  const rect=element=>{
   const r=element.getBoundingClientRect();
   return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};
  };
  const body=root.querySelector('.frontdesk-settings-body');
  return {grid:getComputedStyle(body).display,nav:rect(root.querySelector('.frontdesk-settings-tabs')),
   panel:rect(root.querySelector(name)),body:rect(body),pageWidth:document.documentElement.scrollWidth,
   windowWidth:innerWidth};
 },selector);
 const assertLayout=async selector=>{
  const m=await layout(selector);
  expect(m.grid).toBe('grid');
  expect(Math.abs(m.panel.left-m.nav.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(m.panel.right-m.nav.right)).toBeLessThanOrEqual(2);
  expect(m.panel.top).toBeGreaterThanOrEqual(m.nav.bottom-1);
  expect(m.pageWidth).toBeLessThanOrEqual(m.windowWidth+1);
  return m;
 };
 const original=await assertLayout('#frontdesk-line-panel');
 expect(calls.filter(x=>x.action==='platform.frontdesk.history.list')).toHaveLength(0);
 await section.getByRole('tab',{name:'確認預約'}).click();
 await expect(section.locator('.frontdesk-history-card')).toHaveCount(1);
 await expect(section.locator('.frontdesk-history-card')).toContainText('櫃檯甲');
 await expect(section.locator('.frontdesk-history-card')).toContainText('身體60');
 await expect(section.locator('.frontdesk-history-card')).toContainText('請加強肩頸');
 const confirmedLayout=await assertLayout('#frontdesk-history-panel');
 expect(Math.abs(confirmedLayout.nav.left-original.nav.left)).toBeLessThanOrEqual(2);
 expect(Math.abs(confirmedLayout.nav.width-original.nav.width)).toBeLessThanOrEqual(2);
 await section.getByRole('tab',{name:'拒絕預約'}).click();
 await expect(section.locator('.frontdesk-history-card')).toContainText('該時段已被現場人員預約但未登記');
 await expect(section.locator('.frontdesk-history-card')).toContainText('後續登記的現場／電話預約');
 await expect(section.locator('.frontdesk-history-card')).toContainText('櫃檯人員');
 await assertLayout('#frontdesk-history-panel');
 await section.getByRole('tab',{name:'LINE 設定'}).click();
 await expect(section.locator('[name="loginChannelId"]')).toBeVisible();
 await expect(section.locator('.frontdesk-history-card')).toBeHidden();
 const restored=await assertLayout('#frontdesk-line-panel');
 expect(Math.abs(restored.nav.width-original.nav.width)).toBeLessThanOrEqual(2);
 expect(Math.abs(restored.panel.left-original.panel.left)).toBeLessThanOrEqual(2);
 expect(Math.abs(restored.panel.width-original.panel.width)).toBeLessThanOrEqual(2);
 await page.evaluate(()=>window.LumenTheme.set('dark'));
 await assertLayout('#frontdesk-line-panel');
 await section.getByRole('tab',{name:'確認預約'}).click();
 await expect(section.locator('.frontdesk-history-card')).toHaveCount(1);
 await assertLayout('#frontdesk-history-panel');
 await page.evaluate(()=>window.LumenTheme.set('light'));
 await assertLayout('#frontdesk-history-panel');
 await section.getByRole('tab',{name:'LINE 設定'}).click();
 await assertLayout('#frontdesk-line-panel');
 expect(calls.filter(x=>x.action==='platform.frontdesk.history.list').map(x=>x.status)).toEqual(['confirmed','rejected','confirmed']);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(errors).toEqual([]);
 await info.attach('frontdesk-history-tabs-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
});

test('FRONTDESK_POLICY_SETTINGS — merchant saves only independent title, conflict time bounds removed',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto(base+'/frontdesk/');
 await page.setContent('<main id="root"></main>');
 await page.addScriptTag({url:base+'/admin/frontdesk-settings.js'});
 await page.evaluate(()=>{
  const settings={enabled:true,loginChannelId:'2010999999',liffId:'2010999999-desk',messagingChannelId:'2010888888'};
  window.frontdeskPolicyWrites=[];
  window.FrontdeskSettings.mount({root:document.getElementById('root'),business:'shop-a',request:async(action,body)=>{
   if(action==='platform.frontdesk.preferences.save'){
    window.frontdeskPolicyWrites.push({action,body});
    Object.assign(settings,body.preferences);
    return {frontdesk:{...settings},version:2,staff:[]};
   }
   if(action!=='platform.frontdesk.get')throw Error('Unexpected preferences action: '+action);
   return {frontdesk:{...settings},version:1,staff:[]};
  }});
 });
 await page.locator('summary').click();
 const form=page.locator('form.frontdesk-preferences-form');
 await expect(form).toBeVisible();
 for(const key of ['conflictStartMin','conflictStartMax','conflictDurationMin','conflictDurationMax']){
  await expect(form.locator('[name='+key+']')).toHaveCount(0);
 }
 await expect(form).toContainText('衝突預約開始時間由原預約區間自動產生');
 await form.locator('[name=pageTitle]').fill('獨立櫃檯抬頭');
 await form.getByRole('button',{name:'儲存櫃檯頁面抬頭'}).click();
 await expect(page.locator('[role=status]')).toContainText('已儲存');
 const writes=await page.evaluate(()=>window.frontdeskPolicyWrites);
 expect(writes).toHaveLength(1);
 expect(writes[0].action).toBe('platform.frontdesk.preferences.save');
 expect(writes[0].body.preferences).toEqual({pageTitle:'獨立櫃檯抬頭'});
 expect(Object.hasOwn(writes[0].body,'channelAccessToken')).toBe(false);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('FRONTDESK_ADMIN_REJECTION_LINE_DEEPLINK — automatic scoped before/after display with no other booking',async({page})=>{
 const bookingId='10000000-0000-4000-8000-000000000022',seen=[];
 await page.route('https://static.line-scdn.net/**',route=>route.fulfill({
  contentType:'text/javascript',
  body:'window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>"verified-staff",login:()=>{},logout:()=>{}};'
 }));
 await page.route('https://fixture.supabase.co/**',async route=>{
  const body=route.request().postDataJSON();seen.push(body);let data;
  if(body.action==='frontdesk.public')data={name:'QA商家',frontdesk:{enabled:true,liffId:'2010999999-desk'}};
  else if(body.action==='frontdesk.bootstrap')data={staff:{status:'approved',permissionMode:'review'}};
  else if(body.action==='frontdesk.bookings')data={bookings:[]};
  else if(body.action==='frontdesk.sync.status')data={revision:'1'};
  else if(body.action==='frontdesk.history')data={items:[
   {actorRole:'admin',actionAt:'2026-11-22T09:00:00Z',
    booking:{id:bookingId,status:'rejected',bookingDate:'2026-12-12',startTime:'09:00',endTime:'10:10',totalDurationMinutes:70,name:'甲先生',phone:'0900111222'},
    phoneBooking:{id:'10000000-0000-4000-8000-000000000024',status:'confirmed',bookingDate:'2026-12-12',startTime:'10:10',endTime:'11:40',totalDurationMinutes:90}},
   {actorRole:'admin',actionAt:'2026-11-22T09:01:00Z',
    booking:{id:'10000000-0000-4000-8000-000000000023',status:'rejected',name:'不相關會員',phone:'0900999888'},
    phoneBooking:{id:'10000000-0000-4000-8000-000000000025',status:'confirmed',totalDurationMinutes:30}}
  ]};
  else throw Error('Unexpected action: '+body.action);
  await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data})});
 });
 await page.goto(base+'/frontdesk/?business=shop-a&bookingId='+bookingId);
 const section=page.locator('#frontdeskConflictHistory');
 await expect(section).toBeVisible();
 await expect(section.locator('.frontdesk-history-pair')).toHaveCount(1);
 await expect(section).toContainText('管理端拒絕預約');
 await expect(section).toContainText('原預約資料');
 await expect(section).toContainText('管理端修改後的預約資料');
 await expect(section).toContainText('預約來源：管理端');
 await expect(section).toContainText('預約時間：09:00 – 10:10');
 await expect(section).toContainText('預約時間：10:10 – 11:40');
 await expect(section).toContainText('總時長：90 分鐘');
 await expect(section).toContainText('0900111222');
 await expect(section).not.toContainText('不相關會員');
 await expect(section).not.toContainText('0900999888');
 expect(seen.filter(x=>x.action==='frontdesk.history')).toHaveLength(1);
 expect(seen.find(x=>x.action==='frontdesk.history').bookingId).toBe(bookingId);
});


test('FRONTDESK_REJECTION_SETTINGS_LEGACY — no editor on older server contracts', async({page})=>{
 await page.goto(base+'/frontdesk/');
 await page.setContent('<main id="root"></main>');
 await page.addScriptTag({url:base+'/admin/frontdesk-settings.js'});
 await page.evaluate(()=>{
  window.FrontdeskSettings.mount({root:document.getElementById('root'),business:'shop-a',
   request:async(action)=>{
    if(action==='platform.frontdesk.history.list')return {items:[]};
    if(action!=='platform.frontdesk.get')throw Error('unexpected action '+action);
    return {version:1,frontdesk:{},staff:[]};
   }});
 });
 await page.locator('summary').click();
 await expect(page.locator('form.frontdesk-preferences-form')).toBeVisible();
 await expect(page.locator('[data-frontdesk-rejection-settings]')).toHaveCount(0);
 await expect(page.getByRole('tab',{name:'拒絕預約設定'})).toHaveCount(0);
 await page.getByRole('tab',{name:'LINE 設定'}).focus();
 await page.keyboard.press('ArrowRight');
 await expect(page.getByRole('tab',{name:'確認預約'})).toHaveAttribute('aria-selected','true');
});

for(const width of [390,1280])test('FRONTDESK_REJECTION_SETTINGS_EDITOR_'+width+' — accessible, responsive editor, ordering and frozen replay', async({page},info)=>{
 await page.setViewportSize({width,height:900});
 await page.goto(base+'/frontdesk/');
 await page.setContent('<link rel="stylesheet" href="'+base+'/theme.css">'+
  '<link rel="stylesheet" href="'+base+'/frontdesk/styles.css">'+
  '<link rel="stylesheet" href="'+base+'/admin/frontdesk-settings/frontdesk-settings-page.css">'+
  '<main id="root" class="frontdesk-shell frontdesk-settings-standalone"></main>');
 await page.evaluate(()=>{document.documentElement.dataset.frontdeskPage='true';});
 await page.addScriptTag({url:base+'/admin/frontdesk-settings.js'});
 await page.evaluate(()=>{
  window.rejectionWrites=[];
  let version=7;
  let rejectionSettings={dropdownTitle:'請選擇拒絕原因',reasons:[
   {id:'technician_leave',label:'技師休假',memberDescription:'請另約時間',enabled:true,requiresConflictTime:false},
   {id:'unrecorded_phone_booking',label:'現場預約',memberDescription:'時段已滿',enabled:true,requiresConflictTime:true}
  ]};
  const result=()=>({version,frontdesk:{rejectionSettings:structuredClone(rejectionSettings)},staff:[]});
  window.FrontdeskSettings.mount({root:document.getElementById('root'),business:'shop-a',
   request:async(action,body)=>{
    if(action==='platform.frontdesk.get')return result();
    if(action!=='platform.frontdesk.rejection-settings.save')throw Error('unexpected action '+action);
    window.rejectionWrites.push(structuredClone(body));
    if(window.rejectionWrites.length===1){
     rejectionSettings=structuredClone(body.rejectionSettings);version++;
     throw Object.assign(Error('無法確認結果'),{uncertain:true});
    }
    return result();
   }});
 });
 await page.locator('summary').click();
 const form=page.locator('[data-frontdesk-rejection-settings]');
 const rejectionTab=page.getByRole('tab',{name:'拒絕預約設定'});
 await expect(rejectionTab).toBeVisible();
 await expect(form).toBeHidden();
 await rejectionTab.click();
 await expect(rejectionTab).toHaveAttribute('aria-selected','true');
 await expect(form).toBeVisible();
 await expect(page.locator('#frontdesk-line-panel')).toBeHidden();
 await form.locator('[name=rejectionDropdownTitle]').fill('請選擇本店原因');
 await form.getByRole('button',{name:'新增拒絕原因'}).click();
 const rows=form.locator('fieldset');
 await expect(rows).toHaveCount(3);
 await rows.nth(2).locator('input[type=text]').fill('設備維護');
 await rows.nth(2).locator('textarea').fill('設備維護，請重新預約。');
 await rows.nth(2).getByLabel('需要設定衝突時間並登記現場預約').check();
 await rows.nth(2).getByLabel('有休假技師（櫃檯端可勾選已設定的技師）').check();
 expect(await rows.nth(2).locator('.frontdesk-rejection-toggles label').allTextContents())
  .toEqual(['啟用此拒絕原因','需要設定衝突時間並登記現場預約','有休假技師（櫃檯端可勾選已設定的技師）']);
 await rows.nth(2).getByRole('button',{name:'原因 3 上移'}).click();
 await expect(rows.nth(1).locator('input[type=text]')).toHaveValue('設備維護');
 await rows.nth(2).getByLabel('啟用此拒絕原因').uncheck();
 await expect(rows.nth(2).locator('.frontdesk-rejection-state')).toHaveText('已停用');
 await form.getByRole('button',{name:'儲存拒絕預約設定'}).click();
 await expect(form.getByRole('button',{name:'重試相同儲存操作'})).toBeEnabled();
 await expect(form.locator('textarea').first()).toBeDisabled();
 await form.getByRole('button',{name:'重試相同儲存操作'}).click();
 await expect(page.locator('[role=status]')).toContainText('已儲存');
 const writes=await page.evaluate(()=>window.rejectionWrites);
 expect(writes).toHaveLength(2);
 expect(writes[0]).toEqual(writes[1]);
 expect(writes[0].expectedVersion).toBe(7);
 expect(writes[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
 expect(writes[0].rejectionSettings.dropdownTitle).toBe('請選擇本店原因');
 expect(writes[0].rejectionSettings.reasons[1]).toMatchObject({label:'設備維護',memberDescription:'設備維護，請重新預約。',enabled:true,requiresConflictTime:true,hasVacationTechnicians:true});
 expect(writes[0].rejectionSettings.reasons[1].id).toMatch(/^custom_[0-9a-f-]{36}$/);
 expect(writes[0].rejectionSettings.reasons[2]).toMatchObject({id:'unrecorded_phone_booking',enabled:false});
 await expect(form.locator('[name=rejectionDropdownTitle]')).toHaveValue('請選擇本店原因');
 await expect(form.locator('.frontdesk-rejection-preview').nth(1)).toContainText('設備維護，請重新預約。');
 await page.getByRole('tab',{name:'LINE 設定'}).click();
 await expect(form).toBeHidden();
 await page.getByRole('tab',{name:'拒絕預約設定'}).click();
 await expect(form).toBeVisible();
 await expect(rows.nth(1).locator('textarea')).toHaveValue('設備維護，請重新預約。');
 await expect(rows.nth(2).getByLabel('啟用此拒絕原因')).not.toBeChecked();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expect(form.getByRole('button',{name:'儲存拒絕預約設定'})).toBeVisible();
 await info.attach('frontdesk-rejection-settings-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
});
