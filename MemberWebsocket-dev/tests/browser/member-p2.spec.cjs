const {test,expect}=require('playwright/test');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'../..');let server,base;const fixtures=new Map();
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(['/member/','/booking/','/event/'].includes(url.pathname)){
   const surface=url.pathname.slice(1,-1);let html=fs.readFileSync(path.join(root,surface,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
   const fixture=`window.p2Calls=[];window.p2Friends=[{memberCode:'BBBB',displayName:'王○',status:'pending',incoming:true}];const config={supabaseUrl:location.origin,supabasePublishableKey:'fixture'};
    async function request(c,t,k,action,payload={}){p2Calls.push({action,payload});if(action.endsWith('list'))return {friends:p2Friends};if(action.endsWith('lookup'))return {memberCode:'CCCC',displayName:'陳○'};if(action.endsWith('accept'))p2Friends[0].status='accepted';return {status:'pending'};}
    window.MemberSystem={getSession:()=>({config,idToken:'fixture'}),request};${surface==='booking'?'window.BookingSystem={getSession:()=>({config,idToken:"fixture"})};window.fetch=async(u,o)=>({ok:true,json:async()=>({ok:true,data:await request(null,null,null,JSON.parse(o.body).action,JSON.parse(o.body))})});':''}
    window.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{document.getElementById('loadingView')?.classList.add('hidden');document.getElementById('${surface==='member'?'memberView':surface==='booking'?'bookingView':'eventView'}').classList.remove('hidden');document.getElementById('bookingNotice')?.classList.remove('hidden');
    const grid=document.getElementById('calendarGrid');if(grid)grid.innerHTML='<button type="button">預約日期</button>';
    const events=document.getElementById('eventList');if(events)events.innerHTML='<article class="event-ticket"><h3>QA 活動票券</h3><button type="button">查看並使用</button></article>';
    const profile={lineUserId:new URL(location.href).searchParams.get('account')||'QA-A',profileComplete:true,membershipRequired:false,memberCode:'AAAA',inviteCode:'AAAA000000'};
    window.dispatchEvent(new CustomEvent('${surface==='member'?'member-profile-ready':surface==='booking'?'booking:member-loaded':'p2-unused'}',{detail:{profile}}));window.dispatchEvent(new CustomEvent('user-tour:ready',{detail:{surface:'${surface}',profile}}));},0));`;
   fixtures.set(surface,fixture);html=html.replace('</body>',`<script src="/p2-fixture.js?surface=${surface}"></script><script src="/user-tour.js"></script>${surface==='event'?'':'<script src="/vendor/friend-qrcode.js"></script>'+(surface==='member'?'<script src="/member/member-growth.js"></script><script src="/vendor/friend-qr-decoder.js"></script><script src="/friend-qr-scanner.js"></script>':'')+'<script src="/qr-scan-dialog.js"></script><script src="/dialog-accessibility.js"></script><script src="/friends.js"></script>'}</body>`);
   res.writeHead(200,{'Content-Type':'text/html'});res.end(html);return;
  }
  if(url.pathname==='/p2-fixture.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(fixtures.get(url.searchParams.get('surface')));return;}
  const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream'});res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(r=>server.close(r)));
test.beforeEach(async({page})=>page.route('https://**',r=>r.abort()));
for(const surface of ['booking','event'])for(const [width,theme] of [[320,'light'],[390,'dark'],[1280,'light'],[1280,'dark']])test('tour '+surface+' '+width+' '+theme+' target stays clear and opt-out survives replay',async({page},info)=>{
 await page.setViewportSize({width,height:844});await page.addInitScript(theme=>document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.theme=theme),theme);
 await page.goto(base+'/'+surface+'/');await expect(page.locator('#memberTourDialog')).toBeVisible();
 const target=surface==='event'?'#eventList .event-ticket button':'.booking-accessible-switch';
 for(let i=0;i<(surface==='event'?2:1);i++)await page.locator('#memberTourNext').click();
 await expect(page.locator('#memberTourTitle')).toContainText(surface==='event'?'查看並使用':'操作模式');
 await expect.poll(async()=>page.evaluate(target=>{const a=document.querySelector(target).getBoundingClientRect(),b=document.getElementById('memberTourDialog').getBoundingClientRect();return Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));},target)).toBe(0);
 const box=await page.locator('#memberTourDialog').boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width+1);
 await info.attach('tour-target-layout',{body:await page.screenshot(),contentType:'image/png'});
 expect(await page.evaluate(()=>p2Calls.filter(c=>/claim|redeem|create/.test(c.action)))).toHaveLength(0);
 await page.locator('#memberTourSkip').click();await page.reload();await expect(page.locator('#memberTourDialog')).toBeHidden();
 await page.locator('#openMemberTour').evaluate(b=>b.click());await expect(page.locator('#memberTourDialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#memberTourDialog')).toBeHidden();await page.reload();await expect(page.locator('#memberTourDialog')).toBeHidden();expect(await page.evaluate(()=>(document.getElementById('app')||document.querySelector('.app-shell')).inert)).toBe(false);
});
test('friend link opens the friends tab; add-friend and reward remain separate',async({page},info)=>{
 await page.goto(base+'/member/#friend=BBBB000000');await expect(page.locator('#memberFriendsModal')).toBeVisible();if(await page.locator('#memberTourDismiss').isVisible())await page.locator('#memberTourDismiss').click();
 await expect(page.locator('#memberFriendsModal')).toBeVisible();await expect(page.locator('#memberReferralFriendsTabPanel')).toBeVisible();await expect(page.locator('#memberReferralRewardTabPanel')).toBeHidden();
 await expect(page.locator('#friendQr')).toHaveCount(0);await expect(page.locator('#showFriendQr')).toHaveCount(0);await expect(page.locator('#friendLookupCode')).toHaveValue('BBBB000000');await expect(page.locator('#memberReferralInviteCode')).toHaveValue('');await expect(page.locator('#bindMemberReferral')).toBeDisabled();
 expect(await page.evaluate(()=>p2Calls.filter(c=>!c.action.endsWith('list')))).toHaveLength(0);
 await page.locator('#lookupFriend').click();await expect(page.locator('#friendStatus')).toContainText('查找好友成功：陳○ · CCCC');await expect(page.locator('#confirmFriendRequest')).toBeVisible();await expect(page.locator('#bindMemberReferral')).toBeDisabled();
 await page.locator('#confirmFriendRequest').click();await expect.poll(()=>page.evaluate(()=>p2Calls.filter(c=>c.action==='member.friend.request').length)).toBe(1);expect(await page.evaluate(()=>p2Calls.filter(c=>c.action==='member.referral.bind').length)).toBe(0);
 await page.locator('#friendList button').filter({hasText:'接受'}).click();await expect(page.locator('#friendList')).toContainText('已成為好友');await info.attach('friends-panel',{body:await page.locator('#memberReferralFriendsTabPanel').screenshot(),contentType:'image/png'});
});

async function openFriends(page,tab='friends'){
 const key='member-tour:'+require('node:crypto').createHash('sha256').update('QA-A').digest('hex');
 await page.addInitScript(key=>localStorage.setItem(key,JSON.stringify({version:2,disabled:true,source:'explicit'})),key);
 await page.goto(base+'/member/#friends');await expect(page.locator('#memberFriendsModal')).toBeVisible();if(await page.locator('#memberTourDismiss').isVisible())await page.locator('#memberTourDismiss').click();
 await expect(page.locator('#memberFriendsModal')).toBeVisible();await expect(page.locator('#memberReferralFriendsTabPanel')).toBeVisible();
 if(tab==='reward'){await page.locator('#closeMemberFriends').click();await page.locator('#openMemberReferral').click();await expect(page.locator('#memberReferralModal')).toBeVisible();await expect(page.locator('#memberReferralRewardTabPanel')).toBeVisible();}
}
async function qrPng(page,url){
 return Buffer.from((await page.evaluate(url=>FriendQRCode.toDataURL(url,{width:512,margin:4}),url)).split(',')[1],'base64');
}

test('friends tab groups invite-friend, add-friend and friend list without reward controls',async({page})=>{
 await openFriends(page,'friends');
 await expect(page.locator('#friendInviteSection')).toHaveCount(0);await expect(page.locator('#friendAddForm')).toBeVisible();await expect(page.locator('#friendsPanel')).toBeVisible();
 await expect(page.locator('#memberReferralForm')).toBeHidden();await expect(page.locator('#memberReferralShare')).toHaveCount(0);
 await expect(page.locator('#friendAddForm').locator('text=加好友')).toBeVisible();await expect(page.locator('#scanFriendQr')).toBeVisible();
});

test('reward tab binds referral independently and never sends a friend request',async({page})=>{
 await openFriends(page,'reward');
 await expect(page.locator('#memberReferralInviteCode')).toBeVisible();await expect(page.locator('#friendAddForm')).toBeHidden();
 await page.locator('#memberReferralInviteCode').fill('CCCC');await expect(page.locator('#bindMemberReferral')).toBeEnabled();await page.locator('#bindMemberReferral').click();
 await expect(page.locator('#memberReferralStatus')).toContainText('邀請成功！你已獲得 1 張好友優惠票券');expect(await page.evaluate(()=>p2Calls.filter(c=>c.action==='member.referral.bind').length)).toBe(1);expect(await page.evaluate(()=>p2Calls.filter(c=>c.action==='member.friend.request').length)).toBe(0);expect(await page.evaluate(()=>p2Calls.filter(c=>c.action==='member.friend.lookup').length)).toBe(0);
});

test('reward link opens reward tab and does not prefill add-friend input',async({page})=>{
 const key='member-tour:'+require('node:crypto').createHash('sha256').update('QA-A').digest('hex');await page.addInitScript(key=>localStorage.setItem(key,JSON.stringify({version:2,disabled:true,source:'explicit'})),key);
 await page.goto(base+'/member/#reward=CCCC');await expect(page.locator('#memberReferralModal')).toBeVisible();if(await page.locator('#memberTourDismiss').isVisible())await page.locator('#memberTourDismiss').click();
 await expect(page.locator('#memberReferralModal')).toBeVisible();await expect(page.locator('#memberReferralInviteCode')).toHaveValue('CCCC');await expect(page.locator('#friendLookupCode')).toHaveValue('');
 expect(await page.evaluate(()=>p2Calls.filter(c=>!c.action.endsWith('list')))).toHaveLength(0);
});

test('QR image performs local friend lookup only; reward binding remains untouched',async({page})=>{
 await openFriends(page,'friends');
 await page.locator('#friendQrFile').setInputFiles({name:'friend.png',mimeType:'image/png',buffer:await qrPng(page,base+'/member/#friend=BBBB000000')});
 await expect(page.locator('#friendLookupCode')).toHaveValue('BBBB000000');await expect(page.locator('#confirmFriendRequest')).toBeVisible();await expect(page.locator('#bindMemberReferral')).toBeDisabled();await expect(page.locator('#memberReferralInviteCode')).toHaveValue('');
 expect(await page.evaluate(()=>p2Calls.filter(c=>!c.action.endsWith('list')).map(c=>c.action))).toEqual(['member.friend.lookup']);
 await page.locator('#confirmFriendRequest').click();await expect.poll(()=>page.evaluate(()=>p2Calls.filter(c=>c.action==='member.friend.request').length)).toBe(1);expect(await page.evaluate(()=>p2Calls.filter(c=>c.action==='member.referral.bind').length)).toBe(0);
});

test('camera reads real friend QR frames and stops its video tracks after lookup',async({page})=>{
 await openFriends(page,'friends');
 await page.evaluate(async()=>{
  const canvas=document.createElement('canvas');await FriendQRCode.toCanvas(canvas,location.origin+'/member/#friend=BBBB000000',{width:512,margin:4});
  const stream=canvas.captureStream(10);window.qrCamera={stopped:0,requested:null,stream,canvas};
  for(const track of stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{qrCamera.stopped++;stop();};}
  navigator.mediaDevices.getUserMedia=async options=>{qrCamera.requested=options;return stream;};
 });
 await page.locator('#scanFriendQr').click();await expect(page.locator('#friendLookupCode')).toHaveValue('BBBB000000');await expect(page.locator('#confirmFriendRequest')).toBeVisible();
 expect(await page.evaluate(()=>qrCamera.requested.audio)).toBe(false);expect(await page.evaluate(()=>qrCamera.stopped)).toBe(1);expect(await page.evaluate(()=>qrCamera.stream.getTracks().every(t=>t.readyState==='ended'))).toBe(true);
 await expect(page.locator('#friendQrScanner')).toBeHidden();expect(await page.evaluate(()=>p2Calls.filter(c=>!c.action.endsWith('list')).map(c=>c.action))).toEqual(['member.friend.lookup']);
});

test('camera denial and late permission grant after closing leave manual friend lookup usable',async({page})=>{
 await openFriends(page,'friends');
 await page.evaluate(()=>navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError');});
 await page.locator('#scanFriendQr').click();await expect(page.locator('#friendStatus')).toContainText('相機權限未開啟');await page.locator('#stopFriendQr').click();
 await page.evaluate(()=>{window.lateCameraStopped=0;navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.releaseQrCamera=()=>resolve({getTracks:()=>[{stop:()=>lateCameraStopped++}]}));});
 await page.locator('#scanFriendQr').click();await page.locator('.qr-scan-dialog-heading .qr-scan-dialog-close').click();await page.locator('#closeMemberFriends').click();await page.evaluate(()=>releaseQrCamera());await expect.poll(()=>page.evaluate(()=>lateCameraStopped)).toBe(1);
 await page.locator('#openMemberFriends').click();await page.locator('#friendLookupCode').fill('BBBB000000');await page.locator('#lookupFriend').click();await expect(page.locator('#confirmFriendRequest')).toBeVisible();
 expect(await page.evaluate(()=>p2Calls.filter(c=>/request|referral/.test(c.action)))).toHaveLength(0);
});

test('foreign friend QR cannot lookup, navigate or bind a reward',async({page})=>{
 await openFriends(page,'friends');const url=page.url();
 await page.locator('#friendQrFile').setInputFiles({name:'foreign.png',mimeType:'image/png',buffer:await qrPng(page,'https://foreign.test/member/#friend=BBBB000000')});
 await expect(page.locator('#friendStatus')).toContainText('不是本站');expect(page.url()).toBe(url);await expect(page.locator('#bindMemberReferral')).toBeDisabled();expect(await page.evaluate(()=>p2Calls.filter(c=>!c.action.endsWith('list')))).toHaveLength(0);
});

for(const [width,theme] of [[320,'light'],[390,'dark']])test('separated friend and reward tabs fit '+width+' '+theme+' and retain keyboard focus',async({page},info)=>{
 await page.setViewportSize({width,height:844});await page.addInitScript(theme=>document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.theme=theme),theme);await openFriends(page,'friends');
 const bounds=await page.locator('#memberFriendsModal .member-referral-dialog').boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);expect(await page.locator('#memberFriendsModal .member-referral-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
 await page.locator('#scanFriendQr').scrollIntoViewIfNeeded();await expect(page.locator('#scanFriendQr')).toBeVisible();await page.locator('#closeMemberFriends').click();await page.locator('#openMemberReferral').click();await expect(page.locator('#memberReferralForm')).toBeVisible();await info.attach('friends-reward-mobile',{body:await page.screenshot(),contentType:'image/png'});
 await page.locator('#closeMemberReferral').focus();await page.keyboard.press('Shift+Tab');expect(await page.evaluate(()=>document.getElementById('memberReferralModal').contains(document.activeElement))).toBe(true);
 await page.keyboard.press('Escape');await expect(page.locator('#memberReferralModal')).toBeHidden();await expect(page.locator('#openMemberReferral')).toBeFocused();
});
test('production QR controls runner sees both independent workflows and never performs a bind',async({page})=>{
 await openFriends(page,'friends');await page.evaluate(()=>history.replaceState(null,'','/MemberWebsocket-dev/member/'));await page.evaluate(fs.readFileSync(path.join(root,'qr-scan-dialog.js'),'utf8'));
 await page.evaluate(fs.readFileSync(path.join(root,'user-test-control.js'),'utf8').replace('  window.MemberUserTestControl =','  window.qaNodes={memberQrControlsCase};\n  window.MemberUserTestControl ='));
 const result=await page.evaluate(()=>qaNodes.memberQrControlsCase());expect(result.status,JSON.stringify(result)).toBe('passed');await expect(page.locator('#memberReferralModal')).toBeHidden();expect(await page.evaluate(()=>p2Calls.filter(c=>/request|referral/.test(c.action)))).toHaveLength(0);
});
test('referral QR image prefills the reward workflow and only explicit confirm binds',async({page})=>{
 await openFriends(page,'reward');await page.locator('#memberReferralQrFile').setInputFiles({name:'reward.png',mimeType:'image/png',buffer:await qrPng(page,base+'/member/#reward=CCCC')});
 await expect(page.locator('#memberReferralInviteCode')).toHaveValue('CCCC');expect(await page.evaluate(()=>p2Calls.filter(c=>c.action==='member.referral.bind'))).toHaveLength(0);await page.locator('#bindMemberReferral').click();await expect(page.locator('#memberReferralStatus')).toContainText('邀請成功');expect(await page.evaluate(()=>p2Calls.filter(c=>c.action==='member.referral.bind'))).toHaveLength(1);expect(await page.evaluate(()=>p2Calls.filter(c=>c.action==='member.friend.request'))).toHaveLength(0);
});

test('member QR remains available while friend and reward sharing sections are removed',async({page})=>{
 await openFriends(page);await page.locator('#closeMemberFriends').click();
 const decode=()=>page.locator('#qrDisplayPanel canvas').evaluate(canvas=>{const c=canvas.getContext('2d');return FriendQRDecode(c.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height).data;});
 await page.locator('#showMemberIdentityQr').click();await expect(page.locator('#qrDisplayPanel canvas')).toBeVisible();expect(await decode()).toBe('AAAA');
 await page.keyboard.press('Escape');await expect(page.locator('#showMemberIdentityQr')).toBeFocused();
 await page.locator('#openMemberFriends').click();await expect(page.locator('#friendInviteSection')).toHaveCount(0);await expect(page.locator('#scanFriendQr')).toBeVisible();
 await page.locator('#closeMemberFriends').click();await page.locator('#openMemberReferral').click();await expect(page.locator('#memberReferralShare')).toHaveCount(0);await expect(page.locator('#scanMemberReferralQr')).toBeVisible();
 expect(await page.evaluate(()=>p2Calls.filter(c=>!c.action.endsWith('list')))).toHaveLength(0);
});

for(const [width,theme] of [[320,'light'],[390,'dark'],[1280,'light']])test('membership pass actions stay grouped and usable at '+width+' '+theme,async({page},info)=>{
  await page.setViewportSize({width,height:844});
  await page.addInitScript(theme=>document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.theme=theme),theme);
  await openFriends(page,'friends');
  await page.locator('#closeMemberFriends').click();
  const group=page.locator('#memberPassActions');
  const buttons=group.locator('button.member-referral-trigger');
  await expect(buttons).toHaveCount(3);
  expect(await buttons.evaluateAll(nodes=>nodes.map(node=>node.id))).toEqual(['showMemberIdentityQr','openMemberFriends','openMemberReferral']);
  const layout=await page.evaluate(()=>{
    const pass=document.getElementById('memberPass');
    const actionGroup=document.getElementById('memberPassActions');
    const controls=[...actionGroup.querySelectorAll('button')];
    const area=pass.getBoundingClientRect();
    const qr=controls[0].getBoundingClientRect();
    const friend=controls[1].getBoundingClientRect();
    const referral=controls[2].getBoundingClientRect();
    return {
      layout:getComputedStyle(actionGroup).display,
      bounds:{
        pass:{ left:area.left, right:area.right, width:area.width },
        controls:controls.map(button=>{
          const r=button.getBoundingClientRect();
          return { id:button.id, left:r.left, right:r.right, width:r.width, height:r.height };
        })
      },
      fits:controls.every(button=>{
        const r=button.getBoundingClientRect();
        return r.width>=70 && r.height>=44 && r.left>=area.left-1 && r.right<=area.right+1;
      }),
      // Card ornament pseudo-elements intentionally extend outside its clipped box.
      // Test visible document overflow instead of scrollWidth of the decorative card.
      overflows:document.documentElement.scrollWidth>window.innerWidth+1,
      clipsOrnaments:getComputedStyle(pass).overflowX==='hidden',
      qrFirst:qr.top<=friend.top+1 && qr.top<=referral.top+1,
      qrFullRow:qr.bottom<=friend.top+2,
      sideBySide:Math.abs(friend.top-referral.top)<2,
    };
  });
  expect(layout.layout).toBe('grid');
  expect(layout.fits, JSON.stringify(layout.bounds)).toBe(true);
  expect(layout.overflows).toBe(false);
  expect(layout.clipsOrnaments).toBe(true);
  expect(layout.qrFirst).toBe(true);
  expect(layout.sideBySide).toBe(true);
  if(width<=420)expect(layout.qrFullRow).toBe(true);
  await page.locator('#showMemberIdentityQr').click();
  await expect(page.locator('#qrDisplayPanel canvas')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#showMemberIdentityQr')).toBeFocused();
  await page.locator('#openMemberFriends').click();
  await expect(page.locator('#memberFriendsModal')).toBeVisible();
  await page.locator('#closeMemberFriends').click();
  await page.locator('#openMemberReferral').click();
  await expect(page.locator('#memberReferralModal')).toBeVisible();
  await page.locator('#closeMemberReferral').click();
  await info.attach('member-pass-actions-'+width+'-'+theme,{body:await page.locator('#memberPass').screenshot(),contentType:'image/png'});
});


test('selected-scope friends node reads the list and rejects self without issuing an invitation', async ({page}) => {
  await page.goto(base+'/member/');
  if(await page.locator('#memberTourDismiss').isVisible()) await page.locator('#memberTourDismiss').click();
  await expect(page.locator('#openMemberFriends')).toBeVisible();
  await page.evaluate(() => history.replaceState(null,'','/MemberWebsocket-dev/member/'));
  await page.evaluate(fs.readFileSync(path.join(root,'user-test-control.js'),'utf8').replace(
    '  window.MemberUserTestControl =','  window.scopeProbe={memberFriendControlsCase,state};\n  window.MemberUserTestControl ='));
  await page.evaluate(() => scopeProbe.state.bootstrap={profile:{memberCode:'AAAA'}});
  const result=await page.evaluate(() => scopeProbe.memberFriendControlsCase());
  expect(result.status,JSON.stringify(result)).toBe('passed');
  expect(await page.evaluate(() => p2Calls.filter(row => /request|accept|block|remove/.test(row.action)))).toHaveLength(0);
});
