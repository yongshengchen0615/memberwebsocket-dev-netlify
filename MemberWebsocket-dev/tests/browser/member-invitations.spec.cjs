const {test,expect}=require('playwright/test'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');let server,base;
const fixture=`window.inviteCalls=[];window.nextShareResult=undefined;
 const config={memberInvitationsEnabled:true,business:'shop-a',brandName:'A店會員'};
 window.MemberSystem={getSession:()=>({config,idToken:'synthetic'}),request:async(c,s,t,action,payload)=>{
  inviteCalls.push({action,payload});
  if(action==='member.invitation.create')return {invitationUrl:'https://liff.line.me/1234567890-safe?business=shop-a&invitation='+'a'.repeat(64),expiresAt:new Date(Date.now()+86400000).toISOString(),campaign:{title:'邀請好友優惠'}};
  if(action==='member.invitation.summary'||action==='member.invitation.retry')return {joinedCount:2,rewardedCount:1,pendingCount:1,rewards:[{title:'好友優惠券'}]};
  return {};
 }};
 window.liff={isApiAvailable:()=>true,shareTargetPicker:async(messages,options)=>{window.lastShare={messages,options};return window.nextShareResult;}};
 window.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('loadingView').classList.add('hidden');document.getElementById('memberView').classList.remove('hidden');
  window.dispatchEvent(new CustomEvent('member-profile-ready',{detail:{profile:{lineUserId:'synthetic-a',memberCode:'AAAA',profileComplete:true,membershipRequired:false}}}));
 });`;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/fixture.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(fixture);}
  if(u.pathname==='/member/'){
   const html=fs.readFileSync(path.join(root,'member/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
    .replace('</body>','<script src="/fixture.js"></script><script src="/member/member-growth.js"></script><script src="/member/member-invitations.js"></script></body>');
   res.writeHead(200,{'Content-Type':'text/html'});return res.end(html);
  }
  const file=path.resolve(root,'.'+u.pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream'});res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{await new Promise(r=>server.close(r));});
for(const width of [390,1280])test(`new LINE invitation and truthful cancellation at ${width}px`,async({page},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://**',r=>r.abort());
 await page.setViewportSize({width,height:900});await page.goto(base+'/member/?business=shop-a');
 await page.locator('#openMemberReferral').click();await expect(page.locator('#memberInvitationPanel')).toBeVisible();
 await expect(page.locator('#memberInvitationSummary')).toContainText('成功加入 2 人');
 await expect(page.locator('#memberReferralForm')).toBeHidden();
 await page.locator('#shareMemberInvitation').click();await expect(page.locator('#memberInvitationStatus')).toContainText('已取消分享');
 expect(await page.evaluate(()=>lastShare.options.isMultiple)).toBe(true);
 expect(await page.evaluate(()=>lastShare.messages[0].contents.body.contents.at(-1).action.uri)).toContain('business=shop-a&invitation=');
 await page.evaluate(()=>window.nextShareResult={status:'success'});await page.locator('#shareMemberInvitation').click();
 await expect(page.locator('#memberInvitationStatus')).toContainText('分享操作已完成');
 expect(await page.evaluate(()=>inviteCalls.filter(c=>/bind|retry/.test(c.action)))).toEqual([]);
 expect(await page.evaluate(()=>inviteCalls.filter(c=>c.action==='member.invitation.create').length)).toBe(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await info.attach(`new-invitation-${width}`,{body:await page.locator('#memberReferralModal .member-referral-dialog').screenshot(),contentType:'image/png'});
 await page.keyboard.press('Escape');await expect(page.locator('#memberReferralModal')).toBeHidden();expect(errors).toEqual([]);
});
