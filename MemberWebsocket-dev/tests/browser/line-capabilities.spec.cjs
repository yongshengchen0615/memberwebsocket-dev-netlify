const {test,expect}=require('playwright/test'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const fixture=require('../integration/business-platform-fixture.cjs');
let server,base;
test.beforeAll(async()=>{server=http.createServer((req,res)=>{
 if(req.url==='/settings.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(fs.readFileSync(path.resolve(__dirname,'../../admin/business-line-settings.js')));}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>input,select{max-width:100%;box-sizing:border-box}form{display:grid;gap:8px}label{display:grid}code{overflow-wrap:anywhere}body{margin:16px}</style></head><body><section id="businessWorkspaceStatus"></section><nav id="businessLineFeatureNav" role="tablist"></nav><div id="businessLineFeatureContent"></div></body></html>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.afterAll(async()=>new Promise(r=>server.close(r)));
for(const width of [390,1280])test('#124 LIFF_ONLY_'+width+' — all feature entries save through real handler/SQL with no Messaging credentials',async({page},info)=>{
 const h=await fixture(),owner='U'+'2'.repeat(32),features={membership:true,points:true,events:true,calendar:true,booking:true,integrations:false,testing:false,usage:false};
 const tenant=await h.approve(owner,'liff-browser',features);h.allowedOrigins.add(base);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.setViewportSize({width,height:900});
  await page.route('https://fixture.supabase.co/**',async route=>{
   const response=await h.handler(new Request(route.request().url(),{method:'POST',headers:{Origin:base},body:JSON.stringify(route.request().postDataJSON())}));
   return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  await page.goto(base+'/');
  await page.evaluate(({tenant,features})=>{window.MemberAdminSession={get:()=>({idToken:'manager',config:{business:tenant.slug,supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic'}})};window.qaFeatures=features;},{tenant,features});
  await page.addScriptTag({url:base+'/settings.js'});await page.evaluate(()=>window.BusinessLineSettings.apply({features:window.qaFeatures}));
  await expect(page.locator('[data-business-line-feature]')).toHaveCount(5);
  const fields={membership:'memberLiffId',points:'pointsLiffId',events:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'};
  for(const [feature,key] of Object.entries(fields)){
   await page.locator('#businessLineFeatureTab-'+feature).click();const form=page.locator('#businessLine-'+feature);
   if(feature==='membership'){await form.locator('[name=adminLiffId]').fill('2010791619-admin');await expect(form.locator('[name=adminChannelId]')).toHaveValue('2010791619');}
   await form.locator('[name='+key+']').fill('https://liff.line.me/2010787602-'+feature);await expect(form.locator('[name=memberChannelId]')).toHaveValue('2010787602');
   expect(await form.evaluate(f=>f.checkValidity()),'matched Login/LIFF is a complete entry without Messaging credentials').toBe(true);
   await form.getByRole('button',{name:/儲存.*入口設定/}).click();
   const section=page.locator('[data-business-line-feature="'+feature+'"]');await expect(section.locator(':scope > [role=status]')).toContainText('已儲存');
   await expect(section.getByRole('link',{name:'開啟已儲存的 LINE 入口'})).toHaveAttribute('href','https://liff.line.me/2010787602-'+feature);
   const result=await h.call({action:'platform.business.public',business:tenant.slug,feature});expect(result.status).toBe(200);expect(result.body.data.line[key]).toBe('2010787602-'+feature);
  }
  await expect(page.locator('#notification-calendar-member')).toHaveCount(0);
  expect((await h.db.query('select count(*)::int n from platform_private.module_secrets')).rows[0].n).toBe(0);
  const saved=(await h.db.query('select module_line,version from platform_private.tenants where id=$1',[tenant.id])).rows[0];expect(saved.version).toBe(6);
  for(const value of Object.values(saved.module_line))expect(value.credentialsConfigured).toBe(false);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
  await info.attach('liff-only-settings',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await h.db.close();}
});
