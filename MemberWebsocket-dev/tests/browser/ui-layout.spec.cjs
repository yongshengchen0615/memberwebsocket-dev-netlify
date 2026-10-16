const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {startFixture}=require('./admin-fixture.cjs');
const root=path.resolve(__dirname,'../..');let server,base,admin;
const surfaces=['member','points','event','calendar','booking'];
const item={kind:'points',id:'R1',selectionId:'PT-1',selectable:true,title:'全身舒緩優惠券・長名稱換行測試',cardId:'CARD-1',cardTitle:'身體舒緩集點卡・來源名稱換行測試',pointCost:5,pointBalance:10,statusLabel:'可使用',conditionLabel:'預約項目限制：不限',endsOn:'2099-12-31'};
test.beforeAll(async()=>{
 admin=await startFixture();server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost'),surface=u.pathname.split('/')[1];
  if(surfaces.includes(surface)&&u.pathname===`/${surface}/`){
   let html=fs.readFileSync(path.join(root,surface,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
   const scripts=['ui-components.js','dialog-accessibility.js',...(surface==='member'?['vendor/friend-qrcode.js','vendor/friend-qr-decoder.js','friend-qr-scanner.js','qr-scan-dialog.js','member/member-growth.js','friends.js']:surface==='booking'?['booking/booking-benefits.js','booking/booking-accessible.js','friends.js']:surface==='points'?['points/pointcard-ticket-overview.js']:[])];
   html=html.replace('</body>',`<script src="/layout-fixture.js?surface=${surface}"></script>`+scripts.map(s=>`<script src="/${s}"></script>`).join('')+'</body>');
   res.writeHead(200,{'Content-Type':'text/html'});res.end(html);return;
  }
  if(u.pathname==='/layout-fixture.js'){
   const v=u.searchParams.get('surface');res.writeHead(200,{'Content-Type':'text/javascript'});res.end(`
    const profile={lineUserId:'QA-layout',memberCode:'MEMBER-00001',inviteCode:'AAAA000000',profileComplete:true};
    const config={supabaseUrl:location.origin,supabasePublishableKey:'fixture'};window.layoutCalls=[];
    const request=async(_c,_t,_k,action,payload)=>{layoutCalls.push({action,payload});return action.endsWith('list')?{friends:[{memberCode:'FRIEND-00002',displayName:'陳○',status:'accepted'}]}:action.endsWith('lookup')?{memberCode:'FRIEND-00002',displayName:'陳○'}:{status:'pending'};};
    window.MemberSystem={getSession:()=>({config,idToken:'fixture'}),request};window.fetch=async(_u,o)=>({ok:true,json:async()=>({ok:true,data:o?await request(null,null,null,JSON.parse(o.body).action||'settings',{}):{}})});
    if('${v}'==='booking')window.BookingSystem={getSession:()=>({config,idToken:'fixture'}),bookingBenefits:async()=>({items:[${JSON.stringify(item)}]})};window.BookingReceipts={refresh:async()=>{},openAccessible(){}};
    window.addEventListener('DOMContentLoaded',async()=>{
     document.getElementById('loadingView')?.classList.add('hidden');document.getElementById('${v}View').classList.remove('hidden');document.documentElement.dataset.theme=new URL(location.href).searchParams.get('theme');
     document.querySelector('.account-menu>span')?.replaceChildren('測試會員・長姓名排版驗證');
     if('${v}'==='member')window.dispatchEvent(new CustomEvent('member-profile-ready',{detail:{profile}}));
     if('${v}'==='booking'){
      window.dispatchEvent(new CustomEvent('booking:member-loaded',{detail:{profile}}));BookingBenefits.start(config,'fixture');
      document.getElementById('appointmentPanel').classList.remove('hidden');
     }
     if('${v}'==='points'){
      await PointCardTicketOverview.initialize({config,idToken:'fixture'});PointCardTicketOverview.renderSnapshot({cards:[{cardId:'CARD-1',title:'身體舒緩集點卡・來源名稱換行測試',stamps:10,status:'active',expiryMode:'unlimited',rewards:[{thresholdStamps:5,rewardTitle:'全身舒緩優惠券・長名稱換行測試'}]}],cardDetails:{'CARD-1':{tickets:[{ticketId:'PT-1',ticketType:'coupon',ticketTitle:'全身舒緩優惠券・長名稱換行測試',ticketDescription:'完成服務後由店員核對使用條件。',usageMethod:'向店員出示票券',thresholdStamps:5,status:'available',eligibleBookings:[{bookingId:'BOOK-1'}]}]}}});
     }
    });`);return;
  }
  const file=path.resolve(root,'.'+u.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream'});res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{await admin.close();await new Promise(r=>server.close(r));});
async function fits(locator){const b=await locator.evaluate(el=>{const rect=el.getBoundingClientRect(),style=getComputedStyle(el);return {left:rect.left,right:rect.right,view:innerWidth,overflow:el.scrollWidth-el.clientWidth,clipsOverflow:['hidden','clip'].includes(style.overflowX)};});expect(b.left).toBeGreaterThanOrEqual(-1);expect(b.right).toBeLessThanOrEqual(b.view+1);if(!b.clipsOverflow)expect(b.overflow).toBeLessThanOrEqual(1);}
async function capture(target,info,name,options={}){const file=info.outputPath(name+'.png');await target.screenshot({...options,animations:'disabled',path:file});await info.attach(name,{path:file,contentType:'image/png'});}
for(const width of [320,390,1280])for(const theme of ['light','dark'])test(`shared layouts ${width} ${theme}`,async({page},info)=>{
 await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:'reduce'});await page.route('https://**',r=>r.abort());const errors=[];page.on('pageerror',e=>errors.push(e.message));let ticketStyle;
 for(const surface of surfaces){
  await page.goto(`${base}/${surface}/?theme=${theme}`);await expect(page.locator(`#${surface}View`)).toBeVisible();await fits(page.locator('.topbar'));
  if(surface==='member'){
   await page.locator('#openMemberFriends').click();await expect(page.locator('#memberFriendsModal')).toBeVisible();await fits(page.locator('#memberFriendsModal .member-referral-dialog'));await expect(page.locator('#friendsPanel')).toBeVisible();await expect(page.locator('#friendShareUrl')).toHaveCount(0);
   await page.locator('#closeMemberFriends').click();await page.locator('#openMemberReferral').click();await expect(page.locator('#memberReferralModal')).toBeVisible();await expect(page.locator('#memberReferralOwnCode')).toHaveCount(0);await expect(page.locator('#memberReferralForm')).toBeVisible();
   await expect(page.locator('#memberReferralShare')).toHaveCount(0);await expect(page.locator('#scanMemberReferralQr')).toBeVisible();await capture(page.locator('#memberReferralModal .member-referral-dialog'),info,`friends-${width}-${theme}`);await page.keyboard.press('Escape');expect(await page.locator('.app-shell').evaluate(e=>e.inert)).toBe(false);
  }
  if(surface==='points'||surface==='booking'){
   const card=page.locator(surface==='booking'?'#bookingBenefitsList .ui-ticket':'#pointsView .ui-ticket').first();await expect(card).toBeVisible();await fits(card);await expect(card.locator('.is-source')).toContainText(item.cardTitle);await expect(card.locator('.is-cost')).toContainText('5 點');
   const style=await card.evaluate(e=>{const s=getComputedStyle(e);return {background:s.backgroundColor,color:s.color,radius:s.borderRadius,padding:s.padding};});if(surface==='points')ticketStyle=style;else expect(style).toEqual(ticketStyle);
   if(surface==='booking'){
    await expect(page.locator('.booking-contact-fieldset #friendBookingRecipient')).toBeVisible();await page.locator('#friendBookingRecipient').selectOption('FRIEND-00002');expect(await page.evaluate(()=>MemberFriends.selected())).toBe('FRIEND-00002');
    await page.locator('input[data-booking-benefit-id="PT-1"]').check();expect(await page.evaluate(()=>BookingBenefits.selectionPayload())).toEqual([{kind:'points',id:'PT-1'}]);expect(await page.evaluate(()=>layoutCalls.some(c=>/create|redeem|bind/.test(c.action)))).toBe(false);
    await capture(page.locator('.booking-selection-modal-card'),info,`booking-selection-${width}-${theme}`);
    await page.locator('#appointmentPanel').evaluate(e=>e.classList.add('hidden'));await page.locator('#bookingAccessibleToggle').click();await expect(page.locator('#bookingAccessiblePanel .ui-ticket')).toBeVisible();await fits(page.locator('#bookingAccessiblePanel'));await expect(page.locator('#bookingAccessiblePanel .is-cost')).toContainText('5 點');
   }
  }
  await page.evaluate(()=>scrollTo(0,0));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await capture(page,info,`${surface}-${width}-${theme}`,{fullPage:true});
 }
 await page.goto(admin.base+'/admin/?run='+info.testId);await expect(page.locator('#adminView')).toBeVisible();await expect(page.locator('#syncStatus')).toContainText('已完整同步');await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
 for(const id of ['membersTab','cardsTab','eventsTab','calendarTab','operationsHubTab','bookingTab']){
  const tab=page.locator('#'+id);await expect(tab).toBeVisible();await tab.click();await expect(tab).toHaveAttribute('aria-selected','true');await expect(page.locator('#'+await tab.getAttribute('aria-controls'))).toBeVisible();
  if(id==='operationsHubTab')await expect(page.locator('#integrationHubFreshness')).toContainText('同步於');
  if(id==='bookingTab')await expect(page.locator('#bookingAdminSyncStatus')).toContainText('已同步');
  await fits(page.locator('#adminView>.topbar'));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await capture(page,info,`admin-${id}-${width}-${theme}`,{fullPage:true});
 }
 expect(admin.sessions.get(info.testId).unexpected).toEqual([]);expect(errors).toEqual([]);
});
