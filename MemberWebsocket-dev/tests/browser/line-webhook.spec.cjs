const {test,expect}=require('playwright/test'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {setup}=require('../integration/fixtures/line-webhook-http.cjs');
let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  if(req.url==='/settings.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(fs.readFileSync(path.resolve(__dirname,'../../admin/business-line-settings.js')));}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px}input{max-width:100%;box-sizing:border-box}label{display:grid}form{display:grid;gap:8px}code{overflow-wrap:anywhere}button{margin:4px}</style><section id="businessWorkspaceStatus"></section><nav id="businessLineFeatureNav" role="tablist"></nav><div id="businessLineFeatureContent"></div>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(r=>server.close(r)));
for(const width of [390,1280])test('#144 WEBHOOK_DIAGNOSTICS_'+width+' real handler/SQL, optional LIFF and explicit read-only Provider check',async({page},info)=>{
 const h=await setup();h.allowedOrigins.add(base);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.setViewportSize({width,height:900});
  await page.route('https://fixture.supabase.co/**',async route=>{
   const response=await h.handler(new Request(route.request().url(),{method:'POST',headers:{Origin:base},body:route.request().postData()}));
   await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  await page.goto(base);await page.evaluate(tenant=>{
   window.MemberAdminSession={get:()=>({idToken:'manager',config:{business:tenant.slug,supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic'}})};
   window.grants={membership:true,points:true,events:true,calendar:true,booking:true};
  },h.tenant);
  await page.addScriptTag({url:base+'/settings.js'});await page.evaluate(()=>window.BusinessLineSettings.apply({features:window.grants}));
  await page.locator('#businessLineFeatureTab-booking').click();const panel=page.locator('[data-line-webhook=booking]');await panel.locator('summary').click();
  await panel.getByRole('button',{name:'讀取 Webhook 狀態'}).click();await expect(panel.getByRole('status')).toContainText('LINE API：尚未確認');expect(h.provider).toEqual([]);
  await panel.getByRole('button',{name:'檢查 LINE 連線'}).click();await expect(panel.getByRole('status')).toContainText('LINE API：已接受連線檢查');await expect(panel.getByRole('status')).toContainText('真人收件：待驗收');
  await expect(panel.locator('input')).toHaveValue('https://fixture.supabase.co/functions/v1/line-webhook');
  await panel.getByRole('button',{name:'複製 Webhook URL'}).click();await expect(panel.getByRole('status')).toContainText('已複製');
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('https://fixture.supabase.co/functions/v1/line-webhook');
  expect(h.provider).toEqual(['https://api.line.me/v2/oauth/verify','https://api.line.me/v2/bot/info']);
  await page.locator('#businessLine-booking details').first().locator('summary').click();
  await page.locator('#businessLine-booking [name=channelSecret]').fill('b'.repeat(32));
  await expect(panel.getByRole('button',{name:'檢查 LINE 連線'})).toBeDisabled();
  await page.locator('#businessLineFeatureTab-points').click();const optional=page.locator('[data-line-webhook=points]');await optional.locator('summary').click();
  await optional.getByRole('button',{name:'讀取 Webhook 狀態'}).click();await expect(optional.getByRole('status')).toContainText('LIFF 入口可獨立使用');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
  await info.attach('webhook-diagnostics-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await h.db.close();}
});
