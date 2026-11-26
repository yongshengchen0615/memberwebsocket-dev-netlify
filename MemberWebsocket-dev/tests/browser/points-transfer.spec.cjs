const {test,expect}=require('playwright/test');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');let server,base;
test.beforeAll(async()=>{
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/points/'){
   let html=fs.readFileSync(path.join(root,'points/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
   html=html.replace('</body>','<script src="/fixture.js"></script><script src="/qr-scan-dialog.js"></script><script src="/points/point-transfer.js"></script></body>');
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
test('transfer from accepted friend confirms recipient and credits exactly once',async({page})=>{
 await page.locator('#pointTransferChooseFriend').click();await expect(page.locator('#pointTransferFriendSelect option')).toHaveCount(2);await page.locator('#pointTransferFriendSelect').selectOption('BBBB');await page.locator('#pointTransferUseFriend').click();await expect(page.locator('#pointTransferReceiver')).toContainText('BBBB');
 await transfer(page);expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(1);
});
test('invalid pasted URL cannot transfer points before code confirmation',async({page})=>{
 await page.locator('#pointTransferMemberCode').fill('https://invalid.example/member/');
 await page.locator('#pointTransferLookup').click();
 await expect(page.locator('#pointTransferReceiver')).toBeHidden();
 expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
 await receiver(page);await transfer(page);
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
test('QR scanning controls are absent from code-based point transfers',async({page})=>{
 await expect(page.locator('#pointTransferScanQr')).toHaveCount(0);
 await expect(page.locator('#pointTransferQrFile')).toHaveCount(0);
 await expect(page.locator('#pointTransferMemberCode')).toBeVisible();
 expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
});
test('production recipient runner does not debit and rejects a failed friend fetch',async({page})=>{
 await page.locator('#pointTransferClose').click();await page.evaluate(()=>history.replaceState(null,'','/MemberWebsocket-dev/points/'));await page.evaluate(fs.readFileSync(path.join(root,'user-test-control.js'),'utf8').replace('  window.MemberUserTestControl =','  window.qaNodes={pointsTransferRecipientControlsCase};\n  window.MemberUserTestControl ='));
 const result=await page.evaluate(()=>qaNodes.pointsTransferRecipientControlsCase());expect(result.status,JSON.stringify(result)).toBe('passed');await expect(page.locator('#pointTransferModal')).toBeHidden();expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
 await page.evaluate(()=>qaTransfer.friendError=true);expect((await page.evaluate(()=>qaNodes.pointsTransferRecipientControlsCase())).status).toBe('failed');
});

test('own member code is copyable even with zero transferable points',async({page})=>{
 await page.locator('#pointTransferClose').click();
 await expect(page.locator('.active-card-actions button:visible')).toHaveCount(2);
 await page.setViewportSize({width:320,height:740});
 await page.evaluate(()=>{qaTransfer.sender=0;window.dispatchEvent(new CustomEvent('pointcard:active-changed',{detail:{cardId:'QA-CARD',title:'QA card',stamps:0}}));});
 await expect(page.locator('#pointTransferButton')).toBeDisabled();
 await expect(page.locator('#pointTransferCopyOwnCode')).toBeEnabled();
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async code=>window.copiedMember=code}}));
 await page.locator('#pointTransferCopyOwnCode').click();await expect(page.locator('#pointTransferCopyOwnCode')).toContainText('已複製');
 expect(await page.evaluate(()=>window.copiedMember)).toBe('AAAA');
 expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
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
  await expect(page.locator('#pointTransferCopyOwnCode')).toBeEnabled();
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
  await expect(page.locator('#pointTransferCopyOwnCode')).toBeEnabled();
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

test('revoked member access disables copy action and transfer',async({page})=>{
 await page.locator('#pointTransferClose').click();await expect(page.locator('#pointTransferCopyOwnCode')).toBeEnabled();
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('member:access-ended',{detail:{code:'SESSION_EXPIRED'}})));
 await expect(page.locator('#pointTransferCopyOwnCode')).toBeDisabled();await expect(page.locator('#pointTransferButton')).toBeDisabled();
 expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
});
test('opening focus cannot steal input from an active transfer draft',async({page})=>{
 await page.locator('#pointTransferClose').click();
 const result=await page.evaluate(()=>{
  const queued=[],original=window.setTimeout;
  try{
   window.setTimeout=callback=>{queued.push(callback);return queued.length;};
   document.getElementById('pointTransferButton').click();
   const amount=document.getElementById('pointTransferAmount');amount.focus();amount.value='2';amount.dispatchEvent(new Event('input',{bubbles:true}));
   queued.forEach(callback=>callback());
   return {active:document.activeElement.id,amount:amount.value,writes:qaTransfer.calls.filter(call=>call.action==='points.transfer.create').length};
  }finally{window.setTimeout=original;}
 });
 expect(result).toEqual({active:'pointTransferAmount',amount:'2',writes:0});
});

test('code copy and friend picker are independent of transfer debit',async({page})=>{
 await page.locator('#pointTransferClose').click();
 await expect(page.locator('#pointTransferCopyOwnCode')).toBeVisible();
 await expect(page.locator('#pointTransferModal')).toBeHidden();
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async code=>window.copiedMember=code}}));
 await page.locator('#pointTransferCopyOwnCode').click();
 expect(await page.evaluate(()=>window.copiedMember)).toBe('AAAA');
 await page.locator('#pointTransferButton').click();
 await expect(page.locator('#pointTransferOwnMemberCode')).toHaveText('AAAA');
 await page.locator('#pointTransferAmount').fill('2');await page.locator('#pointTransferMemberCode').fill('BBBB');
 for(let i=0;i<2;i++){
   await page.locator('#pointTransferChooseFriend').click();
   await expect(page.locator('.qr-scan-dialog-overlay #pointTransferFriendPicker')).toBeVisible();
   await page.locator('#pointTransferFriendCancel').click();
 }
 await expect(page.locator('#pointTransferAmount')).toHaveValue('2');
 await expect(page.locator('#pointTransferMemberCode')).toHaveValue('BBBB');
 expect(await page.evaluate(()=>qaTransfer.calls.filter(c=>c.action==='points.transfer.create').length)).toBe(0);
});
