const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'../..',p),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,10));
function page(){
 const dom=new JSDOM('<button id="open">掃描</button><section id="panel" hidden><video></video></section>',{url:'https://example.test/MemberWebsocket-dev/points/',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;
 const style=w.document.createElement('style');style.textContent=read('qr-scan-dialog.css');w.document.head.append(style);
 w.HTMLElement.prototype.getClientRects=()=>[{}];
 w.eval(read('qr-scan-dialog.js'));
 return {dom,w,panel:w.document.getElementById('panel'),opener:w.document.getElementById('open')};
}
test('scanner close button stops resources, restores panel/focus, and can reopen',async()=>{
 const f=page();try{
  let starts=0,stops=0;
  const open=()=>f.w.QRScanDialog.open(f.panel,{opener:f.opener,start:()=>starts++,stop:()=>stops++});
  open();await tick();assert.equal(starts,1);
  f.w.document.querySelector('.qr-scan-dialog-close').click();
  assert.equal(f.w.QRScanDialog.isOpen(),false);
  assert.equal(stops,1);assert.equal(f.panel.hidden,true);assert.equal(f.w.document.activeElement,f.opener);
  open();await tick();assert.equal(starts,2);f.w.QRScanDialog.close(f.panel);assert.equal(stops,2);
 }finally{f.w.close();}
});
test('pagehide closes scanner and a pending start is cancelled',async()=>{
 const f=page();try{
  let starts=0,stops=0;
  f.w.QRScanDialog.open(f.panel,{start:()=>starts++,stop:()=>stops++});
  f.w.dispatchEvent(new f.w.Event('pagehide'));await tick();
  assert.equal(f.w.QRScanDialog.isOpen(),false);assert.equal(starts,0);assert.equal(stops,1);
 }finally{f.w.close();}
});

test('QR display is lazy, purpose-specific, cancels stale rendering and reports errors',async()=>{
 const f=page();try{
  const values=[];let complete;
  f.w.FriendQRCode={toCanvas:(_canvas,value)=>{values.push(value);return new Promise(r=>complete=r);}};
  for(const value of ['AAAA','https://example.test/MemberWebsocket-dev/member/#friend=AAAA','https://example.test/MemberWebsocket-dev/member/#reward=AAAA']){
   assert.equal(f.w.QRDisplayDialog.show({memberCode:'AAAA',value,opener:f.opener}),true);
   await tick();assert.equal(f.w.document.querySelector('#qrDisplayPanel canvas').hidden,true);
   complete();await tick();assert.equal(f.w.document.querySelector('#qrDisplayPanel canvas').hidden,false);
   f.w.document.querySelector('.qr-scan-dialog-close').click();assert.equal(f.w.QRScanDialog.isOpen(),false);
   assert.equal(f.w.getComputedStyle(f.w.document.getElementById('qrDisplayPanel')).display,'none','Closing must hide the restored display panel');
  }
  assert.deepEqual(values,['AAAA','https://example.test/MemberWebsocket-dev/member/#friend=AAAA','https://example.test/MemberWebsocket-dev/member/#reward=AAAA']);
  f.w.QRDisplayDialog.show({memberCode:'AAAA'});await tick();f.w.QRDisplayDialog.close();complete();await tick();
  assert.equal(f.w.document.querySelector('#qrDisplayPanel canvas').hidden,true);
  f.w.FriendQRCode.toCanvas=async()=>{throw new Error('offline');};
  f.w.QRDisplayDialog.show({memberCode:'AAAA'});await tick();assert.match(f.w.document.getElementById('qrDisplayPanel').textContent,/暫時無法顯示/);
 }finally{f.w.close();}
});

test('points transfer production page loads its own QR encoder before display and transfer handlers',()=>{
 const html=read('points/index.html');
 const scripts=Array.from(html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g),match=>match[1].split('?')[0]);
 const encoder=scripts.indexOf('../vendor/friend-qrcode.js');
 const dialog=scripts.indexOf('../qr-scan-dialog.js');
 const transfer=scripts.indexOf('./point-transfer.js');
 assert.ok(encoder>=0,'points page must load the QR encoder; browser fixtures must not mask a missing asset');
 assert.ok(dialog>encoder,'QR encoder must load before the display dialog');
 assert.ok(transfer>dialog,'transfer click handler must load after the QR display dialog');
 assert.match(read('vendor/friend-qrcode.js'),/FriendQRCode/,'the encoder asset must exist');
});

test('points transfer removes only the outer copy button; the QR dialog still offers copy',async()=>{
 const transfer=read('points/point-transfer.js');
 assert.doesNotMatch(transfer,/pointTransferCopyOwnCode|copyOwnMemberCode|point-transfer-copy-proxy/);
 const f=page();try{
  f.w.FriendQRCode={toCanvas:async()=>{}};
  assert.equal(f.w.QRDisplayDialog.show({memberCode:'AAAA',title:'我的會員 QR Code',opener:f.opener}),true);
  await tick();
  const dialog=f.w.document.getElementById('qrDisplayPanel');
  assert.equal(dialog.querySelector('strong').textContent,'AAAA');
  assert.equal(dialog.querySelector('button').textContent,'複製會員編號');
  f.w.QRDisplayDialog.close();
 } finally {f.w.close();}
});

test('points page exposes its own QR button outside the transfer modal',()=>{
 const doc=new JSDOM(read('points/index.html')).window.document;
 const buttons=Array.from(doc.querySelectorAll('.active-card-actions > button'));
 assert.deepEqual(buttons.map(button=>button.id),['pointTransferButton','pointTransferShowOwnQr']);
 assert.equal(buttons[1].getAttribute('aria-haspopup'),'dialog');
 assert.equal(buttons[1].disabled,true);
 assert.equal(doc.querySelector('#pointTransferModal'),null,'transfer dialog is lazy');
 const transfer=read('points/point-transfer.js');
 assert.doesNotMatch(transfer,/<button id="pointTransferShowOwnQr"/,'QR button must not be nested in transfer markup');
 assert.match(transfer,/qrButton\.addEventListener\('click'/,'outside QR button must have its own listener');
});

test('member QR dialog still copies the member identifier without the card copy button', async () => {
 const f=page();try {
  const copied=[];
  Object.defineProperty(f.w.navigator,'clipboard',{configurable:true,value:{writeText:async value=>copied.push(value)}});
  f.w.FriendQRCode={toCanvas:async()=>{}};
  assert.equal(f.w.QRDisplayDialog.show({memberCode:'MEMB1234',opener:f.opener}),true);
  await tick();
  const dialog=f.w.document.getElementById('qrDisplayPanel');
  assert.equal(dialog.querySelector('strong').textContent,'MEMB1234');
  const copy=Array.from(dialog.querySelectorAll('button')).find(button=>button.textContent==='複製會員編號');
  assert.ok(copy);
  copy.click();await tick();
  assert.deepEqual(copied,['MEMB1234']);
  assert.match(dialog.textContent,/會員編號已複製/);
 }finally{f.w.close();}
});

test('member QR clipboard success survives deferred QR rendering, and denied clipboard reports failure', async () => {
 const f=page();try {
  let finishRender;
  const copied=[];
  f.w.FriendQRCode={toCanvas:()=>new Promise(resolve=>{finishRender=resolve;})};
  Object.defineProperty(f.w.navigator,'clipboard',{configurable:true,value:{writeText:async value=>copied.push(value)}});
  assert.equal(f.w.QRDisplayDialog.show({memberCode:'SLOW1234',opener:f.opener}),true);
  await tick();
  const panel=f.w.document.getElementById('qrDisplayPanel');
  const copy=Array.from(panel.querySelectorAll('button')).find(button=>button.textContent==='複製會員編號');
  assert.ok(copy);
  copy.click();await tick();
  assert.match(panel.textContent,/會員編號已複製/);
  assert.deepEqual(copied,['SLOW1234']);
  assert.equal(typeof finishRender,'function');
  finishRender();await tick();
  assert.match(panel.textContent,/會員編號已複製/,'late QR rendering must not overwrite clipboard success');
  assert.equal(panel.querySelector('canvas').hidden,false);
  f.w.QRDisplayDialog.close();
  f.w.FriendQRCode.toCanvas=async()=>{};
  f.w.navigator.clipboard.writeText=async()=>{throw new Error('permission denied');};
  assert.equal(f.w.QRDisplayDialog.show({memberCode:'SLOW1234',opener:f.opener}),true);
  await tick();
  const second=f.w.document.getElementById('qrDisplayPanel');
  Array.from(second.querySelectorAll('button')).find(button=>button.textContent==='複製會員編號').click();
  await tick();
  assert.match(second.textContent,/無法複製/,'denied Clipboard API must report failure');
  assert.doesNotMatch(second.textContent,/會員編號已複製/);
 }finally{f.w.close();}
});
