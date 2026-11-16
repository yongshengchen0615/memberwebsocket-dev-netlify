const {test,expect}=require('playwright/test');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const root=path.resolve(__dirname,'../..');let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const p=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(p.endsWith('/')?p+'index.html':p));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/json');res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(r=>server.close(r)));
for(const environment of ['production','testing'])for(const surface of ['points','booking'])test('MEMBER_JOIN_'+environment+'_'+surface+' — membership-required recovery discovers the same merchant membership LIFF',async({page})=>{
 const profile=JSON.parse(fs.readFileSync(path.join(root,'config',environment,'config.json'),'utf8')),calls=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/config.json*',r=>r.fulfill({json:{...profile,realtimeEnabled:false}}));
 await page.route('https://cdn.jsdelivr.net/**',r=>r.abort());
 await page.route('https://static.line-scdn.net/**',r=>r.fulfill({contentType:'text/javascript',body:"window.initializedLiffIds=[];window.liff={init:async({liffId})=>window.initializedLiffIds.push(liffId),isInClient:()=>true,isLoggedIn:()=>true,getIDToken:()=> 'synthetic',getProfile:async()=>({displayName:'Synthetic'}),openWindow:({url})=>location.assign(url)};"}));
 await page.route(profile.supabaseUrl+'/functions/v1/**',async route=>{
  const headers={'Access-Control-Allow-Origin':base,'Access-Control-Allow-Headers':'content-type,apikey','Access-Control-Allow-Methods':'POST,OPTIONS'};
  if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers});
  const body=JSON.parse(route.request().postData()||'{}');calls.push(body);
  if(body.action==='platform.business.public'){
   const line=body.feature==='membership'?{memberLiffId:'2010787602-Member'}:body.feature==='points'?{pointsLiffId:'2010787602-Points'}:{bookingLiffId:'2010787602-Booking'};
   return route.fulfill({headers,json:{ok:true,data:{business:'merchant-a',name:'QA',features:{membership:true,points:true,booking:true},line:{adminLiffId:'2010791619-Admin',memberChannelId:'2010787602',...line}}}});
  }
  if(String(body.action).endsWith('.bootstrap')&&!String(body.action).startsWith('user.member.'))return route.fulfill({status:403,headers,json:{ok:false,error:{code:'MEMBERSHIP_REQUIRED',message:'請先加入會員'}}});
  return route.fulfill({headers,json:{ok:true,data:{state:'claimed',profile:{profileComplete:false,membershipRequired:true},terms:{version:1,title:'合成條款',body:'合成條款'}}}});
 });
 await page.goto(base+'/'+surface+'/?business=merchant-a');
 await expect(page.locator('#joinMemberButton')).toBeVisible();
 await expect(page.locator('#retryButton')).toBeHidden();
 await page.locator('#joinMemberButton').click();
 await expect(page).toHaveURL(base+'/member/?business=merchant-a');
 await expect.poll(()=>page.evaluate(()=>window.initializedLiffIds)).toEqual(['2010787602-Member']);
 await expect(page.locator('#profileSetupView')).toBeVisible();
 expect(calls.filter(c=>c.action==='platform.business.public').map(c=>c.feature)).toEqual([surface==='points'?'points':'booking','membership']);
 expect(calls.filter(c=>c.action==='platform.business.public'||c.action==='user.member.bootstrap').every(c=>c.business==='merchant-a')).toBe(true);
 expect(errors).toEqual([]);
});
