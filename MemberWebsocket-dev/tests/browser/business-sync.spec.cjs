const {test,expect}=require('playwright/test'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
let server,base;
test.beforeAll(async()=>{server=http.createServer((req,res)=>{
 if(req.url==='/sync.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(fs.readFileSync(path.resolve(__dirname,'../../member-system.js')));}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="UTF-8"><body><output id="value"></output></body>');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;});
test.afterAll(async()=>new Promise(r=>server.close(r)));
test('BUSINESS_SYNC — actual browser runtime refreshes two authorized views, preserves another shop and stops cleanly',async({context})=>{
 const authority={'shop-a':{revision:'1',value:'A initial'},'shop-b':{revision:'1',value:'B initial'}},calls=[];
 const pages=[];
 try{
  for(const business of ['shop-b','shop-a','shop-a']){
   const page=await context.newPage();pages.push(page);await page.clock.install({time:new Date('2026-10-20T00:00:00Z')});
   await page.route('https://fixture.supabase.co/**',async route=>{
    const body=route.request().postDataJSON();calls.push({...body,tabIndex:pages.indexOf(page)});const state=authority[body.business];
    if(!state)return route.fulfill({status:403,json:{ok:false,error:{code:'BUSINESS_FORBIDDEN'}}});
    return route.fulfill({json:{ok:true,data:body.action==='admin.sync.status'?{revision:state.revision}:{value:state.value}}});
   });
   await page.goto(base+'/');await page.addScriptTag({url:base+'/sync.js'});
   await page.evaluate(async business=>{
    window.liff={init:async()=>{},isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=> 'synthetic-token'};
    window.cfg={business,realtimeEnabled:true,supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic',adminLiffId:'admin',memberLiffId:'member'};
    await window.MemberSystem.signIn(window.cfg,'admin');
    window.stopSync=window.MemberSystem.subscribeRealtime(window.cfg,'admin',async()=>{
     const data=await window.MemberSystem.request(window.cfg,'admin','synthetic-token','admin.bootstrap',{business});document.querySelector('#value').textContent=data.value;
    });
   },business);
   await page.bringToFront();await page.clock.runFor(1);await expect(page.locator('#value')).toHaveText(authority[business].value);
  }
  authority['shop-a']={revision:'2',value:'A changed'};
  await pages[2].clock.runFor(10000);await expect(pages[2].locator('#value')).toHaveText('A changed');
  await pages[1].bringToFront();await pages[1].clock.runFor(1);await expect(pages[1].locator('#value')).toHaveText('A changed');
  const before=calls.filter(c=>c.business==='shop-b'&&c.action==='admin.bootstrap').length;
  await pages[0].bringToFront();await pages[0].clock.runFor(10001);await expect(pages[0].locator('#value')).toHaveText('B initial');
  expect(calls.filter(c=>c.business==='shop-b'&&c.action==='admin.bootstrap')).toHaveLength(before);
  await pages[2].bringToFront();await pages[2].clock.runFor(1);await pages[2].evaluate(()=>window.stopSync());
  // Unsubscribing the third tab must stop requests from THAT tab.
  // Another authorized tab for the same shop is intentionally still subscribed.
  const probes=calls.filter(c=>c.tabIndex===2&&c.business==='shop-a'&&c.action==='admin.sync.status').length;
  await pages[2].clock.runFor(60000);
  expect(calls.filter(c=>c.tabIndex===2&&c.business==='shop-a'&&c.action==='admin.sync.status')).toHaveLength(probes);
 }finally{for(const page of pages)await page.close();}
});
