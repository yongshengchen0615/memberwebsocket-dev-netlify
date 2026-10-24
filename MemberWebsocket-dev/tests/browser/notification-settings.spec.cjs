const {test,expect}=require('playwright/test'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const fixture=require('../integration/business-platform-fixture.cjs'),{key}=require('../integration/platform-fixture.cjs');
let server,base;
test.beforeAll(async()=>{server=http.createServer((req,res)=>{
 if(req.url==='/settings.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(fs.readFileSync(path.resolve(__dirname,'../../admin/business-line-settings.js')));}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>input,select{max-width:100%;box-sizing:border-box}form{display:grid;gap:8px}label{display:grid}code{overflow-wrap:anywhere}body{margin:16px}</style></head><body><section id="businessWorkspaceStatus"></section><nav id="businessLineFeatureNav" role="tablist"></nav><div id="businessLineFeatureContent"></div><section id="membersPanel"></section><section id="bookingPanel"></section><section id="cardsPanel"></section></body></html>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.afterAll(async()=>new Promise(r=>server.close(r)));
for(const width of [390,1280])test('NOTIFICATION_PURPOSES_'+width+' — independent verified channels, lost-response replay, test recipient and disable on real SQL',async({page},info)=>{
 const h=await fixture(),owner='U'+'2'.repeat(32),features={membership:true,points:false,events:false,calendar:false,booking:true,integrations:false,testing:false,usage:false};
 const tenant=await h.approve(owner,'notice-browser',features);h.allowedOrigins.add(base);
 const {createPlatformHandler}=await import('../../supabase/functions/_shared/platform-handler.mjs');
 const provider=[];let lose=true,valid=true;
 const handler=createPlatformHandler({db:{rpc:h.rpc},allowedOrigins:h.allowedOrigins,encryptionKey:()=>key,verifyIdentity:()=>{throw Error('ROOT_NOT_ALLOWED');},verifyApplicantIdentity:async()=>({lineUserId:owner}),
 fetchImpl:async(url,options)=>{provider.push({url,options});return new Response(JSON.stringify({client_id:valid?'2010123456':'wrong',expires_in:3600}),{status:200,headers:{'x-line-request-id':'synthetic-request-id'}});}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.setViewportSize({width,height:900});
  await page.route('https://fixture.supabase.co/**',async route=>{
   const body=route.request().postDataJSON();const response=await handler(new Request(route.request().url(),{method:'POST',headers:{Origin:base},body:JSON.stringify(body)}));
   if(body.action==='platform.notifications.save'&&lose){lose=false;return route.abort('failed');}
   return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  await page.goto(base+'/');expect(await page.evaluate(()=>document.characterSet)).toBe('UTF-8');
  await page.evaluate(({tenant,features})=>{window.MemberAdminSession={get:()=>({idToken:'synthetic-provider-verified',config:{business:tenant.slug,supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic'}})};window.qaFeatures=features;},{tenant,features});
  await page.addScriptTag({url:base+'/settings.js'});await page.evaluate(()=>window.BusinessLineSettings.apply({features:window.qaFeatures}));
  await expect(page.locator('[data-business-line-feature]')).toHaveCount(2);
  await expect(page.locator('#notification-points-member')).toHaveCount(0);
  await expect(page.locator('#businessLineFeatureNav [role="tab"]')).toHaveCount(2);
  const firstTab=page.locator('#businessLineFeatureTab-membership'),bookingTab=page.locator('#businessLineFeatureTab-booking');
  await firstTab.focus();await page.keyboard.press('ArrowRight');await expect(bookingTab).toBeFocused();await expect(bookingTab).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('Home');await expect(firstTab).toBeFocused();await expect(firstTab).toHaveAttribute('tabindex','0');
  await page.keyboard.press('End');await expect(bookingTab).toBeFocused();await expect(firstTab).toHaveAttribute('tabindex','-1');
  await page.locator('#businessLineFeatureTab-booking').click();
  await expect(page.locator('[data-business-line-feature="booking"]')).toBeVisible();
  await expect(page.locator('[data-business-line-feature="membership"]')).toBeHidden();
  const admin=page.locator('#notification-booking-admin'),member=page.locator('#notification-booking-member');
  await page.locator('[data-business-line-feature="booking"] > details').evaluate(d=>d.open=true);
  await admin.locator('select').selectOption('custom');await admin.locator('[name=messagingChannelId]').fill('2010123456');await admin.locator('[name=channelAccessToken]').fill('synthetic-browser-notification-token-123456');
  await admin.getByRole('button',{name:'驗證並儲存通知設定'}).click();await expect(admin.locator('[role=status]')).toContainText('無法確認');
  await expect(member.getByRole('button',{name:'驗證並儲存通知設定'})).toBeDisabled();
  await admin.getByRole('button',{name:'重試相同儲存操作'}).click();await expect(admin.locator('[role=status]')).toContainText('已儲存');await expect(admin.locator('[name=channelAccessToken]')).toHaveValue('');
  let saved=(await h.db.query('select * from platform_private.tenants where id=$1',[tenant.id])).rows[0];expect(saved.version).toBe(2);expect(saved.module_line.booking.notifications.member).toBeUndefined();
  await admin.getByRole('button',{name:'傳送測試給我'}).click();await expect(admin.locator('[role=status]')).toContainText('LINE 已接受');
  const push=provider.find(c=>c.url.endsWith('/push'));expect(JSON.parse(push.options.body).to).toBe(owner);expect(push.options.headers['X-Line-Retry-Key']).toMatch(/^[a-f0-9-]{36}$/);
  valid=false;await member.locator('select').selectOption('custom');await member.locator('[name=messagingChannelId]').fill('2010123456');await member.locator('[name=channelAccessToken]').fill('synthetic-invalid-channel-token-123456');await member.getByRole('button',{name:'驗證並儲存通知設定'}).click();await expect(member.locator('[role=status]')).toContainText('不屬於');
  await member.locator('select').selectOption('disabled');await member.getByRole('button',{name:'驗證並儲存通知設定'}).click();await expect(member.locator('[role=status]')).toContainText('已儲存');await expect(member.getByRole('button',{name:'傳送測試給我'})).toBeDisabled();
  saved=(await h.db.query('select * from platform_private.tenants where id=$1',[tenant.id])).rows[0];expect(saved.module_line.booking.notifications.admin.mode).toBe('custom');expect(saved.module_line.booking.notifications.member.mode).toBe('disabled');
  expect((await h.db.query("select count(*)::int n from platform_private.audit_events where action='NOTIFICATION_ROUTE_UPDATED'")).rows[0].n).toBe(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
  await info.attach('notification-settings',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await h.db.close();}
});
