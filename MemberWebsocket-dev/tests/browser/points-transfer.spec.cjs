const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/points/'){
   let html=fs.readFileSync(path.join(root,'points/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
   html=html.replace('</body>','<script src="/fixture.js"></script><script src="/vendor/friend-qrcode.js"></script><script src="/vendor/friend-qr-decoder.js"></script><script src="/friend-qr-scanner.js"></script><script src="/qr-scan-dialog.js"></script><script src="/points/point-transfer.js"></script></body>');
   res.writeHead(200,{'Content-Type':'text/html'});res.end(html);return;
  }
  if(u.pathname==='/fixture.js'){
   res.writeHead(200,{'Content-Type':'text/javascript'});res.end(`
    window.qaTransfer={calls:[],sender:5,receiver:0,results:{},uncertain:false,friendError:false};
    const config={supabaseUrl:location.origin};
    window.MemberSystem={getSession:()=>({config,idToken:'isolated'}),request:async(c,t,k,action,p={})=>{
      qaTransfer.calls.push({action,payload:structuredClone(p)});
      if(action==='points.transfer.options')return {cards:[{cardId:'QA-CARD',title:'QA card',balance:qaTransfer.sender}]};
      if(action==='member.friend.list'){if(qaTransfer.friendError)throw new Error('好友載入失敗');return {friends:[{memberCode:'BBBB',displayName:'QA receiver',status:'accepted'},{memberCode:'CCCC',displayName:'Pending',status:'pending'}]};}
      if(action==='points.transfer.receiver'){if(p.memberCode==='AAAA')throw Object.assign(new Error('不可轉贈給自己'),{status:400});return {memberCode:p.memberCode,displayName:'QA receiver'};}
      if(action==='points.transfer.create'){
        if(qaTransfer.results[p.requestId])return qaTransfer.results[p.requestId];
        if(p.memberCode==='AAAA'||!Number.isInteger(p.amount)||p.amount<=0||p.amount>qaTransfer.sender)throw Object.assign(new Error('拒絕非法轉贈'),{status:400});
        qaTransfer.sender-=p.amount;qaTransfer.receiver+=p.amount;
        const result={transferId:'QA-TRANSFER',senderBalance:qaTransfer.sender};qaTransfer.results[p.requestId]=result;
        if(qaTransfer.uncertain){qaTransfer.uncertain=false;throw Object.assign(new Error('Uncertain result'),{status:503,code:'API_RESPONSE_UNCERTAIN'});}return result;
      }
      throw new Error('Unexpected action '+action);
    }};
    window.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{
      document.getElementById('loadingView').classList.add('hidden');document.getElementById('pointsView').classList.remove('hidden');
      document.getElementById('activeCardView').dataset.cardStyle='citrus';document.getElementById('activeCardTitle').textContent='QA card';document.getElementById('progressCount').textContent='5';
      window.dispatchEvent(new CustomEvent('user-tour:ready',{detail:{surface:'points',profile:{memberCode:'AAAA'}}}));
      window.dispatchEvent(new CustomEvent('pointcard:active-changed',{detail:{cardId:'QA-CARD',title:'QA card',stamps:5}}));
    },0));
   `);return;
  }
  const file=path.resolve(root,'.'+u.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream'});res.end(fs.readFileSync(file));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>new Promise(resolve=>server.close(resolve)));
test.beforeEach(async({page})=>{await page.route('https://**',route=>route.abort());page.on('dialog',dialog=>dialog.accept());await page.goto(base+'/points/');await expect(page.locator('#pointTransferButton')).toBeEnabled();await page.locator('#pointTransferButton').click();});
async function receiver(page){await page.locator('#pointTransferMemberCode').fill('BBBB');await page.locator('#pointTransferLookup').click();await expect(page.locator('#pointTransferReceiver')).toContainText('BBBB');}
async function transfer(page){await page.locator('#pointTransferAmount').fill('2');await page.locator('#pointTransferLookup').click();await expect(page.locator('#pointTransferReceiver')).toContainText('BBBB');await page.locator('#pointTransferSubmit').click();await expect(page.locator('#pointTransferMessage')).toContainText('轉贈完成');expect(await page.evaluate(()=>[qaTransfer.sender,qaTransfer.receiver])).toEqual([3,2]);}
async function qr(page,url){return Buffer.from((await page.evaluate(url=>FriendQRCode.toDataURL(url,{width:512,margin:4}),url)).split(',')[1],'base64');}
test('transfer from accepted friend confirms recipient and credits exactly once',async({page})=>{
 await page.locator('#pointTransferChooseFriend').click();await expect(page.locator('#pointTransferFriendSelect option')).toHaveCount(2);await page.locator('#pointTransferFriendSelect').selectOption('BBBB');await page.locator('#pointTransferUseFriend').click();await expect(page.locator('#pointTransferReceiver')).toContainText('BBBB');
 await transfer(page);expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(1);
});
test('QR image only looks up recipient until explicit transfer; foreign QR cannot navigate or debit',async({page})=>{
 await page.evaluate(()=>navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError');});await page.locator('#pointTransferScanQr').click();await expect(page.locator('.qr-scan-dialog-overlay')).toBeVisible();
 await page.locator('#pointTransferQrFile').setInputFiles({name:'foreign.png',mimeType:'image/png',buffer:await qr(page,'https://foreign.invalid/member/#friend=BBBB')});await expect(page.locator('#pointTransferQrStatus')).toHaveText('不是本站的會員 QR Code。');expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.receiver').length)).toBe(0);
 await page.locator('#pointTransferQrFile').setInputFiles({name:'member.png',mimeType:'image/png',buffer:await qr(page,base+'/member/#friend=BBBB')});await expect(page.locator('#pointTransferReceiver')).toContainText('BBBB');expect(await page.evaluate(()=>[qaTransfer.sender,qaTransfer.receiver])).toEqual([5,0]);await transfer(page);
});
test('manual transfer double submit and uncertain replay after reopening conserve balances',async({page})=>{
 await page.locator('#pointTransferAmount').fill('2');await receiver(page);await page.evaluate(()=>qaTransfer.uncertain=true);await page.locator('#pointTransferSubmit').evaluate(button=>{button.click();button.click();});await expect(page.locator('#pointTransferMessage')).toContainText('結果尚未確認');await expect(page.locator('#pointTransferMemberCode')).toBeDisabled();
 const first=await page.evaluate(()=>qaTransfer.calls.find(c=>c.action==='points.transfer.create').payload);expect(await page.evaluate(()=>[qaTransfer.sender,qaTransfer.receiver])).toEqual([3,2]);
 await page.locator('#pointTransferClose').click();await expect(page.locator('#pointTransferButton')).toBeDisabled();await expect(page.locator('#pointTransferPendingButton')).toBeEnabled();await page.locator('#pointTransferPendingButton').click();await expect(page.locator('#pointTransferMemberCode')).toHaveValue('BBBB');await page.locator('#pointTransferSubmit').click();await expect(page.locator('#pointTransferMessage')).toContainText('轉贈完成');
 expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').map(c=>c.payload.requestId))).toEqual([first.requestId,first.requestId]);expect(await page.evaluate(()=>[qaTransfer.sender,qaTransfer.receiver])).toEqual([3,2]);
});
test('friend load failure and self recipient preserve balances and allow manual recovery',async({page})=>{
 await page.evaluate(()=>qaTransfer.friendError=true);await page.locator('#pointTransferChooseFriend').click();await expect(page.locator('#pointTransferFriendStatus')).toContainText('好友載入失敗');await page.locator('#pointTransferFriendCancel').click();await page.locator('#pointTransferMemberCode').fill('AAAA');await page.locator('#pointTransferLookup').click();await expect(page.locator('#pointTransferMessage')).toContainText('不可轉贈給自己');await expect(page.locator('#pointTransferReceiver')).toBeHidden();expect(await page.evaluate(()=>[qaTransfer.sender,qaTransfer.receiver])).toEqual([5,0]);await receiver(page);await transfer(page);
});
test('QR dialog closes on Escape and stops late camera without writing a transfer',async({page})=>{
 await page.evaluate(()=>{window.stopped=0;navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.releaseCamera=()=>resolve({getTracks:()=>[{stop:()=>stopped++}]}));});
 await page.locator('#pointTransferScanQr').click();await expect(page.locator('.qr-scan-dialog-overlay')).toBeVisible();await expect.poll(()=>page.evaluate(()=>typeof releaseCamera)).toBe('function');await page.keyboard.press('Escape');await expect(page.locator('.qr-scan-dialog-overlay')).toHaveCount(0);await page.evaluate(()=>releaseCamera());await expect.poll(()=>page.evaluate(()=>stopped)).toBe(1);await expect(page.locator('#pointTransferScanQr')).toBeFocused();expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
});
test('production recipient runner does not debit and rejects a failed friend fetch',async({page})=>{
 await page.locator('#pointTransferClose').click();await page.evaluate(()=>history.replaceState(null,'','/MemberWebsocket-dev/points/'));await page.evaluate(fs.readFileSync(path.join(root,'user-test-control.js'),'utf8').replace('  window.MemberUserTestControl =','  window.qaNodes={pointsTransferRecipientControlsCase};\n  window.MemberUserTestControl ='));
 const result=await page.evaluate(()=>qaNodes.pointsTransferRecipientControlsCase());expect(result.status,JSON.stringify(result)).toBe('passed');await expect(page.locator('#pointTransferModal')).toBeHidden();expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
 await page.evaluate(()=>qaTransfer.friendError=true);expect((await page.evaluate(()=>qaNodes.pointsTransferRecipientControlsCase())).status).toBe('failed');
});

test('own QR button remains accessible next to transfer without transferable points',async({page})=>{
 await page.locator('#pointTransferClose').click();
 const actions=page.locator('.active-card-actions');
 await expect(actions.locator('button:visible')).toHaveCount(2);
 await expect(actions.locator('#pointTransferShowOwnQr')).toBeEnabled();
 await page.setViewportSize({width:320,height:740});
 const transferBox=await page.locator('#pointTransferButton').boundingBox();
 const qrBox=await page.locator('#pointTransferShowOwnQr').boundingBox();
 expect(qrBox.x).toBeGreaterThan(transferBox.x);
 expect(qrBox.x+qrBox.width).toBeLessThanOrEqual(321);
 await page.evaluate(()=>{qaTransfer.sender=0;window.dispatchEvent(new CustomEvent('pointcard:active-changed',{detail:{cardId:'QA-CARD',title:'QA card',stamps:0}}));});
 await expect(page.locator('#pointTransferButton')).toBeDisabled();
 await expect(page.locator('#pointTransferShowOwnQr')).toBeEnabled();
 await page.locator('#pointTransferShowOwnQr').click();
 await expect(page.locator('#qrDisplayPanel canvas')).toBeVisible();
 await expect(page.locator('#pointTransferModal')).toBeHidden();
 expect(await page.locator('#qrDisplayPanel').locator('strong').textContent()).toBe('AAAA');
 expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
 await page.locator('.qr-scan-dialog-heading .qr-scan-dialog-close').click();
 await expect(page.locator('#pointTransferShowOwnQr')).toBeFocused();
});
test('zero available points keep transfer disabled after uncertain full-balance transfer, with separate safe recovery',async({page})=>{
  await page.evaluate(()=>qaTransfer.uncertain=true);
  await page.locator('#pointTransferAmount').fill('5');
  await receiver(page);
  await page.locator('#pointTransferSubmit').click();
  await expect(page.locator('#pointTransferMessage')).toContainText('結果尚未確認');
  expect(await page.evaluate(()=>[qaTransfer.sender,qaTransfer.receiver])).toEqual([0,5]);
  await page.locator('#pointTransferClose').click();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('pointcard:active-changed',{detail:{cardId:'QA-CARD',title:'QA card',stamps:0}})));
  await expect(page.locator('#pointTransferButton')).toBeDisabled();
  await expect(page.locator('#pointTransferButton')).toHaveAttribute('title','請先確認前次轉贈交易');
  await expect(page.locator('#pointTransferShowOwnQr')).toBeEnabled();
  await expect(page.locator('#pointTransferPendingButton')).toBeEnabled();
  await page.locator('#pointTransferButton').evaluate(button=>button.click());
  await expect(page.locator('#pointTransferModal')).toBeHidden();
  await page.locator('#pointTransferPendingButton').click();
  await expect(page.locator('#pointTransferMemberCode')).toHaveValue('BBBB');
  await expect(page.locator('#pointTransferAmount')).toHaveValue('5');
  await page.locator('#pointTransferSubmit').click();
  await expect(page.locator('#pointTransferMessage')).toContainText('轉贈完成');
  const requestIds=await page.evaluate(()=>qaTransfer.calls.filter(call=>call.action==='points.transfer.create').map(call=>call.payload.requestId));
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  expect(await page.evaluate(()=>[qaTransfer.sender,qaTransfer.receiver])).toEqual([0,5]);
  await expect(page.locator('#pointTransferButton')).toBeDisabled();
  await expect(page.locator('#pointTransferPendingButton')).toBeHidden();
});

test('15 reserved of 15 raw points keeps transfer disabled even after options API returns 15',async({page})=>{
  await page.locator('#pointTransferClose').click();
  const previous=await page.evaluate(()=>qaTransfer.calls.filter(call=>call.action==='points.transfer.options').length);
  await page.evaluate(()=>{
    qaTransfer.sender=15; // Backend options still reports the unreserved raw balance.
    document.getElementById('progressCount').textContent='0';
    document.getElementById('progressMessage').textContent='0 點可用 · 15 點已預約';
    window.dispatchEvent(new CustomEvent('pointcard:active-changed',{detail:{
      cardId:'QA-CARD',title:'QA card',stamps:0,totalStamps:15,
      reservedStamps:15,generalReservedStamps:15,transferEligible:true
    }}));
  });
  await page.waitForFunction(count=>qaTransfer.calls.filter(call=>call.action==='points.transfer.options').length>count,previous);
  await page.waitForTimeout(80);
  await expect(page.locator('#pointTransferButton')).toBeDisabled();
  await expect(page.locator('#pointTransferButton')).toHaveAttribute('title','可用點數為 0，無法轉贈');
  await page.locator('#pointTransferButton').evaluate(button=>button.click());
  await expect(page.locator('#pointTransferModal')).toBeHidden();
  await expect(page.locator('#pointTransferShowOwnQr')).toBeEnabled();
  expect(await page.evaluate(()=>qaTransfer.calls.filter(call=>call.action==='points.transfer.create').length)).toBe(0);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('pointcard:active-changed',{detail:{
    cardId:'QA-CARD',title:'QA card',stamps:15,totalStamps:15,reservedStamps:0,transferEligible:true
  }})));
  await expect(page.locator('#pointTransferButton')).toBeEnabled();
  await page.locator('#pointTransferButton').click();
  await expect(page.locator('#pointTransferAmount')).toHaveAttribute('max','15');
  await receiver(page);
  await page.locator('#pointTransferAmount').fill('1');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('pointcard:active-changed',{detail:{
    cardId:'QA-CARD',title:'QA card',stamps:0,totalStamps:15,reservedStamps:15,transferEligible:true
  }})));
  await expect(page.locator('#pointTransferAmount')).toHaveAttribute('max','0');
  await expect(page.locator('#pointTransferSubmit')).toBeDisabled();
  await expect(page.locator('#pointTransferMessage')).toContainText('可用點數為 0');
  await page.locator('#pointTransferSubmit').evaluate(button=>button.click());
  expect(await page.evaluate(()=>qaTransfer.calls.filter(call=>call.action==='points.transfer.create').length)).toBe(0);
});

test('member access ending disables independent QR action and closes displayed QR',async({page})=>{
 await page.locator('#pointTransferClose').click();
 await page.locator('#pointTransferShowOwnQr').click();
 await expect(page.locator('#qrDisplayPanel canvas')).toBeVisible();
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('member:access-ended',{detail:{code:'SESSION_EXPIRED'}})));
 await expect(page.locator('#pointTransferShowOwnQr')).toBeDisabled();
 await expect(page.locator('#qrDisplayPanel')).toBeHidden();
 expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
});
test('own QR and friend picker are separate actions, and transfer form remains usable',async({page})=>{
 await page.locator('#pointTransferClose').click();
 await expect(page.locator('#pointTransferCopyOwnCode')).toHaveCount(0);
 await expect(page.locator('#pointTransferShowOwnQr')).toBeVisible();
 await expect(page.locator('#pointTransferModal')).toBeHidden();
 await page.locator('#pointTransferShowOwnQr').click();
 await expect(page.locator('#qrDisplayPanel canvas')).toBeVisible();
 await expect(page.locator('#qrDisplayPanel button').filter({hasText:'複製會員編號'})).toBeVisible();
 expect(await page.locator('#qrDisplayPanel canvas').evaluate(canvas=>{const c=canvas.getContext('2d');return FriendQRDecode(c.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height).data;})).toBe('AAAA');
 await page.locator('.qr-scan-dialog-heading .qr-scan-dialog-close').click();
 await expect(page.locator('#pointTransferShowOwnQr')).toBeFocused();
 await expect(page.locator('#qrDisplayPanel')).toBeHidden();
 await page.locator('#pointTransferButton').click();
 await expect(page.locator('#pointTransferOwnMemberCode')).toHaveText('AAAA');
 await page.locator('#pointTransferAmount').fill('2');await page.locator('#pointTransferMemberCode').fill('BBBB');
 for(let i=0;i<2;i++){await page.locator('#pointTransferChooseFriend').click();await expect(page.locator('.qr-scan-dialog-overlay #pointTransferFriendPicker')).toBeVisible();await page.locator('#pointTransferFriendCancel').click();}
 await expect(page.locator('#pointTransferAmount')).toHaveValue('2');await expect(page.locator('#pointTransferMemberCode')).toHaveValue('BBBB');
 expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
});
