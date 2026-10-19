const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const fixture=require('../integration/business-platform-fixture.cjs');
let server,base;const root=path.resolve(__dirname,'../..');
test.beforeAll(async()=>{server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');const file=path.resolve(root,'.'+(u.pathname.endsWith('/')?u.pathname+'index.html':u.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/json'});res.end(fs.readFileSync(file));});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.afterAll(async()=>new Promise(r=>server.close(r)));
test('ACCESS_LIFECYCLE — suspended row survives reload, exact retry reinstates once, expiry uses Taipei time',async({page},info)=>{
 const h=await fixture();h.allowedOrigins.add(base);let lost=false;const requests=[],errors=[];
 try{
  const t=await h.approve('U'+'2'.repeat(32),'lifecycle-ui');
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.addInitScript(()=>sessionStorage.setItem('platform-line-login-return-v1',String(Date.now())));
  await page.route('**/config.json',r=>r.fulfill({json:{supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'sb_publishable_fixture',platformLiffId:'2012065297-VunxFBj8',productizedAdmin:true}}));
  await page.route('https://static.line-scdn.net/**',r=>r.fulfill({contentType:'text/javascript',body:"window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>'root'};"}));
  await page.route('https://fixture.supabase.co/functions/v1/platform-api',async route=>{
   const body=route.request().postDataJSON();requests.push(body);
   const response=await h.handler(new Request(route.request().url(),{method:'POST',headers:{Origin:base},body:JSON.stringify(body)}));
   if(body.action==='platform.tenant.resume'&&!lost){lost=true;return route.abort('failed');}
   return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  await page.goto(base+'/platform/');await expect(page.locator('#tenantList')).toContainText('lifecycle-ui');
  await expect(page.locator('#unifiedPortalNav')).toHaveCount(0);
  await page.getByRole('button',{name:'停用商家',exact:true}).click();await expect(page.locator('#tenantList')).toContainText('已停用');
  await page.reload();await expect(page.getByRole('button',{name:'復權',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'復權',exact:true}).click();await expect(page.getByRole('button',{name:'重試相同復權操作'})).toBeEnabled();
  await expect(page.locator('#platformStatus')).toContainText('結果尚未確認');
  await page.getByRole('button',{name:'重試相同復權操作'}).click();await expect(page.locator('#platformStatus')).toContainText('已復權');
  const resume=requests.filter(x=>x.action==='platform.tenant.resume');expect(resume).toHaveLength(2);expect(resume[0]).toEqual(resume[1]);
  expect((await h.db.query("select count(*)::int n from platform_private.audit_events where action='TENANT_RESUMED'")).rows[0].n).toBe(1);
  await page.getByRole('button',{name:'設定使用期限'}).click();await page.locator('#expiryUnlimited').uncheck();await page.locator('#expiryAt').fill('2020-01-02T00:30');
  await page.getByRole('button',{name:'儲存使用期限',exact:true}).click();await expect(page.locator('#expiryDialog')).toBeHidden();await expect(page.locator('#tenantList')).toContainText('使用期限已到');
  const row=(await h.db.query('select * from platform_private.tenants where id=$1',[t.id])).rows[0];expect(new Date(row.expires_at).toISOString()).toBe('2020-01-01T16:30:00.000Z');expect(row.features).toEqual(t.features);
  await page.getByRole('button',{name:'設定使用期限'}).click();await page.locator('#expiryUnlimited').check();await page.getByRole('button',{name:'儲存使用期限',exact:true}).click();await expect(page.locator('#tenantList')).toContainText('無到期日');
  expect(errors).toEqual([]);await info.attach('access-lifecycle',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 }finally{await h.db.close();}
});
