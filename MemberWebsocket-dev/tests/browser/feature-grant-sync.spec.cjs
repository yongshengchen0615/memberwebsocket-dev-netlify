const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const businessFixture=require('../integration/business-platform-fixture.cjs');
const {fixture,transport}=require('./admin-fixture.cjs');
const root=path.resolve(__dirname,'../..'),owner='U'+'2'.repeat(32);
let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost'),file=path.resolve(root,'.'+(u.pathname.endsWith('/')?u.pathname+'index.html':u.pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/json'});res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(r=>server.close(r)));
for(const width of [390,1280])test(`AC-SYNC-001..005_${width}: root SQL grant changes reach the open real admin, preserve drafts and recover tabs`,async({page},info)=>{
 const h=await businessFixture(),s=fixture(),errors=[],calls=[];h.allowedOrigins.add(base);
 const all={membership:true,points:true,events:true,calendar:true,booking:true,integrations:false,testing:false,usage:false};
 const t=await h.approve(owner,'live-grants',all);
 const {syncRevision}=await import('../../supabase/functions/_shared/sync-revision.mjs');
 const {assertBusinessAction,businessResponse}=await import('../../supabase/functions/_shared/business-policy.mjs');
 // Production revision function reads a real isolated tenant schema. Only the
 // external LINE provider and unrelated admin persistence use existing fixtures.
 const scoped=features=>({businessFeatures:features,from(table){let columns,conditions=[],args=[],limit='';const q={select(v){columns=v;return q;},eq(k,v){args.push(v);conditions.push(`${k}=$${args.length}`);return q;},in(k,v){args.push(v);conditions.push(`${k}=any($${args.length})`);return q;},order(){limit=' order by id desc';return q;},limit(n){limit+=' limit '+n;return q;},async maybeSingle(){return{data:(await h.db.query(`select ${columns} from ${t.runtime_schema}.${table} where ${conditions.join(' and ')}${limit}`,args)).rows[0]||null,error:null};}};return q;}});
 const grants=async features=>{
  const current=(await h.db.query('select version from platform_private.tenants where id=$1',[t.id])).rows[0];
  const r=await h.call({action:'platform.tenant.features.save',tenantId:t.id,expectedVersion:current.version,features,requestId:crypto.randomUUID()});
  expect(r.status,JSON.stringify(r.body)).toBe(200);
 };
 try{
  await page.setViewportSize({width,height:900});page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install();
  await page.route('**/config.json',r=>r.fulfill({json:{brandName:'QA',supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'sb_publishable_fixture',adminLiffId:'2010791619-admin',memberLiffId:'2010787602-member',platformLiffId:'2012065297-VunxFBj8',productizedAdmin:true,merchantApprovalVersion:2}}));
  await page.route('https://static.line-scdn.net/**',r=>r.fulfill({contentType:'text/javascript',body:'window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=>"manager"};'}));
  await page.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({contentType:'text/javascript',body:''}));
  await page.route('https://fixture.supabase.co/functions/v1/**',async route=>{
   const body=route.request().postDataJSON();calls.push(body.action||body.operation);
   if(route.request().url().endsWith('/platform-api')){
    const headers=new Headers(route.request().headers());headers.set('Origin',base);
    const r=await h.handler(new Request(route.request().url(),{method:'POST',headers,body:JSON.stringify(body)}));
    return route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()});
   }
   const current=(await h.db.query('select * from platform_private.tenants where id=$1',[t.id])).rows[0],action=body.action||body.operation;
   try{
    assertBusinessAction(current,action,body);
    const data=action==='admin.sync.status'?await syncRevision(scoped(current.features),'admin',owner,(status,code,message)=>Object.assign(Error(message),{status,code})):businessResponse(await transport(s,action,body,new URL(route.request().url()).pathname.split('/').at(-1)),current,action);
    return route.fulfill({json:{ok:true,data}});
   }catch(e){return route.fulfill({status:e.status||400,json:{ok:false,error:{code:e.code,message:e.message}}});}
  });
  await page.goto(base+'/admin/?business='+t.slug);await expect(page.locator('#adminView')).toBeVisible();
  await page.locator('#bookingTab').click();await page.locator('#bookingAdminServicesSubtab').click();await page.locator('#bookingAdminNewTypeButton').click();
  const reward=page.locator('[data-type-reward-enabled]');await expect(reward).toBeVisible();
  await page.locator('[data-type-name]').fill('尚未儲存的類型');await reward.check();await page.locator('[data-type-reward-minutes]').fill('75');
  await expect.poll(()=>calls.filter(a=>a==='admin.sync.status').length).toBeGreaterThan(0);
  await page.clock.pauseAt(await page.evaluate(()=>Date.now()+100));
  const events=(await h.db.query(`select count(*)::int n from ${t.runtime_schema}.realtime_events`)).rows[0].n;
  await grants({...all,points:false});await page.clock.runFor(3001);
  await expect(reward).toBeHidden();await expect(page.locator('#bookingAdminCrudModal')).toBeVisible();
  await expect(page.locator('[data-type-name]')).toHaveValue('尚未儲存的類型');await expect(page.locator('[data-type-reward-minutes]')).toHaveValue('75');
  await grants(all);await page.clock.runFor(3001);await expect(reward).toBeVisible();await expect(reward).toBeChecked();
  await page.locator('#bookingAdminCrudModalClose').click();
  const tabs={membership:'members',points:'cards',events:'events',calendar:'calendar',booking:'booking'};
  for(const [feature,name]of Object.entries(tabs)){
   await page.locator('#'+name+'Tab').click();await grants({...all,[feature]:false});await page.clock.runFor(3001);
   await expect(page.locator('#'+name+'Tab')).toBeHidden();
   await expect(page.locator('#adminView .surface-nav [aria-selected="true"]')).toBeVisible();
   await grants(all);await page.clock.runFor(3001);await expect(page.locator('#'+name+'Tab')).toBeVisible();
  }
  expect((await h.db.query(`select count(*)::int n from ${t.runtime_schema}.realtime_events`)).rows[0].n).toBe(events);
  expect(errors).toEqual([]);
  await info.attach('grant-sync-'+width,{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
  await info.attach('grant-sync-requests',{body:JSON.stringify(calls),contentType:'application/json'});
 }finally{await page.close();await h.db.close();}
});
