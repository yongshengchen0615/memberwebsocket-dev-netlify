const {test}=require('node:test');const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const fs=require('node:fs');const path=require('node:path');
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
function fixture(){
 const dom=new JSDOM('<video></video>',{url:'https://example.test/MemberWebsocket-dev/member/',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,video=w.document.querySelector('video'),results=[],statuses=[];w.TextEncoder=TextEncoder;
 for(const file of ['vendor/friend-qrcode.js','vendor/friend-qr-decoder.js','friend-qr-scanner.js'])w.eval(fs.readFileSync(path.resolve(__dirname,'../..',file),'utf8'));
 const scanner=w.FriendQRScanner.create(video,{onResult:value=>results.push(value),onStatus:value=>statuses.push(value)});
 return {dom,w,video,scanner,results,statuses};
}
function pixels(w,text){
 const qr=w.FriendQRCode.create(text),scale=4,margin=4,size=(qr.modules.size+2*margin)*scale;
 const data=new w.Uint8ClampedArray(size*size*4);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const row=Math.floor(y/scale)-margin,col=Math.floor(x/scale)-margin;
  const dark=row>=0&&col>=0&&row<qr.modules.size&&col<qr.modules.size&&qr.modules.get(row,col);
  const offset=(y*size+x)*4;data[offset]=data[offset+1]=data[offset+2]=dark?0:255;data[offset+3]=255;
 }
 return {data,width:size,height:size};
}
test('real vendored QR encoder and decoder round-trip a same-site invitation',()=>{
 const f=fixture();try{
  const value='https://example.test/MemberWebsocket-dev/member/#friend=BBBB000000',p=pixels(f.w,value);
  assert.equal(typeof f.w.FriendQRDecode,'function');
  assert.equal(f.w.FriendQRDecode(p.data,p.width,p.height).data,value);
  assert.equal(f.w.FriendQRScanner.parseInvitation(value),'BBBB000000');
 }finally{f.dom.window.close();}
});
test('parser accepts member codes and friend links but rejects referral links and invalid contents',()=>{
 const f=fixture();try{
  const parse=f.w.FriendQRScanner.parseInvitation;
  for(const value of [' abcd1234 ','https://example.test/MemberWebsocket-dev/member/#friend=abcd1234'])assert.equal(parse(value),'ABCD1234');
  for(const value of ['','abc','javascript:alert(1)','https://example.test/MemberWebsocket-dev/member/#invite=abcd1234','https://example.test/MemberWebsocket-dev/member/index.html?invite=abcd1234','https://example.test/MemberWebsocket-dev/member/#reward=abcd1234','//other.test/member/','https://other.test/MemberWebsocket-dev/member/#friend=ABCD1234','https://example.test/MemberWebsocket-dev/admin/#friend=ABCD1234','https://user:secret@example.test/MemberWebsocket-dev/member/#friend=ABCD1234','https://example.test/MemberWebsocket-dev/member/#friend=bad%20code','https://example.test/MemberWebsocket-dev/member/','X'.repeat(2049)])assert.throws(()=>parse(value));
 }finally{f.dom.window.close();}
});
test('a late camera grant after close stops every track and never plays',async()=>{
 const f=fixture();try{
  let grant,stopped=0,played=0;
  Object.defineProperty(f.w.navigator,'mediaDevices',{value:{getUserMedia:options=>{assert.equal(options.audio,false);assert.equal(options.video.facingMode.ideal,'environment');return new Promise(resolve=>grant=resolve);}}});
  f.video.play=async()=>{played++;};const pending=f.scanner.start();f.scanner.stop();
  grant({getTracks:()=>[{stop:()=>stopped++},{stop:()=>stopped++}]});await pending;
  assert.equal(stopped,2);assert.equal(played,0);assert.equal(f.video.srcObject,null);assert.deepEqual(f.results,[]);
 }finally{f.dom.window.close();}
});
test('permission denial preserves code and image fallbacks; another start can recover',async()=>{
 const f=fixture();try{
  let stopped=0;Object.defineProperty(f.w.navigator,'mediaDevices',{value:{getUserMedia:async()=>{const error=new Error();error.name='NotAllowedError';throw error;}}});
  await f.scanner.start();assert.match(f.statuses.at(-1),/相機權限未開啟.*QR 圖片/);
  f.w.navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop:()=>stopped++}]});f.video.play=async()=>{};
  await f.scanner.start();f.scanner.stop();assert.equal(stopped,1);assert.equal(f.video.srcObject,null);
 }finally{f.dom.window.close();}
});
test('file decode uses the real decoder, emits only a parsed code and releases its bitmap',async()=>{
 const f=fixture();try{
  const p=pixels(f.w,'https://example.test/MemberWebsocket-dev/member/#friend=BBBB000000');let closed=0,drawn=0;
  f.w.HTMLCanvasElement.prototype.getContext=()=>({drawImage:()=>drawn++,getImageData:()=>p});
  f.w.createImageBitmap=async()=>({width:p.width,height:p.height,close:()=>closed++});
  await f.scanner.readFile({type:'image/png',size:3000});assert.deepEqual(f.results,['BBBB000000']);assert.equal(closed,1);assert.equal(drawn,1);
 }finally{f.dom.window.close();}
});
test('late file result is discarded after close or account invalidation and releases bitmap',async()=>{
 const f=fixture();try{
  let resolve,closed=0,drawn=0;f.w.createImageBitmap=()=>new Promise(r=>resolve=r);
  f.w.HTMLCanvasElement.prototype.getContext=()=>({drawImage:()=>drawn++});
  const pending=f.scanner.readFile({type:'image/png',size:3000});f.scanner.stop();resolve({width:200,height:200,close:()=>closed++});await pending;
  assert.equal(closed,1);assert.equal(drawn,0);assert.deepEqual(f.results,[]);
 }finally{f.dom.window.close();}
});
test('file validation rejects oversized, unsupported, empty and foreign QR images without lookup',async()=>{
 const f=fixture();try{
  let reads=0,closed=0;f.w.createImageBitmap=async()=>{reads++;return {width:9000,height:9000,close:()=>closed++};};
  await f.scanner.readFile({type:'image/svg+xml',size:100});await f.scanner.readFile({type:'image/png',size:11*1024*1024});assert.equal(reads,0);
  await f.scanner.readFile({type:'image/png',size:100});assert.match(f.statuses.at(-1),/圖片尺寸過大/);assert.equal(closed,1);
  const p=pixels(f.w,'https://foreign.test/member/#friend=BBBB000000');f.w.createImageBitmap=async()=>({width:p.width,height:p.height,close:()=>closed++});
  f.w.HTMLCanvasElement.prototype.getContext=()=>({drawImage:()=>{},getImageData:()=>p});await f.scanner.readFile({type:'image/png',size:100});assert.match(f.statuses.at(-1),/不是本站/);assert.deepEqual(f.results,[]);
  p.data.fill(255);await f.scanner.readFile({type:'image/png',size:100});assert.match(f.statuses.at(-1),/未找到 QR Code/);
 }finally{f.dom.window.close();}
});


test('shared scanner can decode a referral QR with a purpose-specific parser without accepting it as a friend QR',async()=>{
 const f=fixture();try{
  const video=f.w.document.createElement('video'),results=[],statuses=[];
  const scanner=f.w.FriendQRScanner.create(video,{
   label:'邀請優惠',onStatus:value=>statuses.push(value),onResult:value=>results.push(value),
   parseValue:raw=>{const url=new f.w.URL(raw);const value=new f.w.URLSearchParams(url.hash.slice(1)).get('reward')||'';if(!/^[A-Za-z0-9_-]{4,40}$/.test(value))throw new Error('邀請優惠 QR Code 格式不正確。');return value.toUpperCase();}
  });
  const p=pixels(f.w,'https://example.test/MemberWebsocket-dev/member/#reward=CCCC000000');
  f.w.HTMLCanvasElement.prototype.getContext=()=>({drawImage:()=>{},getImageData:()=>p});
  f.w.createImageBitmap=async()=>({width:p.width,height:p.height,close:()=>{}});
  await scanner.readFile({type:'image/png',size:3000});
  assert.deepEqual(results,['CCCC000000']);
  assert.throws(()=>f.w.FriendQRScanner.parseInvitation('https://example.test/MemberWebsocket-dev/member/#reward=CCCC000000'));
 }finally{f.dom.window.close();}
});
