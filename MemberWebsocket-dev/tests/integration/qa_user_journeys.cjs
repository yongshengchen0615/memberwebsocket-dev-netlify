// Production UI handlers with isolated transport. This lane supplies DOM evidence;
// Playwright still verifies real clipboard, PNG decoding and camera frames.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
async function page(surface){
 const d=new JSDOM(read(surface+'/index.html'),{url:'https://example.test/MemberWebsocket-dev/'+surface+'/',runScripts:'outside-only',pretendToBeVisual:true});
 await new Promise(resolve=>d.window.addEventListener('load',resolve,{once:true}));
 return d;
}
function nodes(w){
 w.eval(read('user-test-control.js').replace('  window.MemberUserTestControl =','  window.qaNodes={memberCodeCopyCase,memberQrControlsCase,pointsTransferRecipientControlsCase};\n  window.MemberUserTestControl ='));
 return w.qaNodes;
}

test('member code runner uses the production copy handler and fails denied clipboard',async()=>{
 const d=await page('member'),w=d.window;let clipboard='';
 try{
  Object.defineProperty(w,'isSecureContext',{value:true});
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async value=>{clipboard=value;}}});
  w.MemberSystem={bindDialogKeyboard(){},loadConfig:async()=>({}),signIn:async()=> 'isolated',initials:()=> 'QA',formatDate:value=>value,subscribeRealtime:()=>()=>{},request:async()=>({profile:{memberCode:'QA-CODE',displayName:'QA',profileComplete:true,membershipRequired:false,joinedAt:'2026-01-01'}})};
  w.MembershipProgress={render(){}};
  w.eval(read('member/app.js'));w.dispatchEvent(new w.Event('DOMContentLoaded'));await tick();
  const n=nodes(w),result=await n.memberCodeCopyCase();
  assert.equal(result.status,'passed',JSON.stringify(result));assert.equal(clipboard,'QA-CODE');
  w.navigator.clipboard.writeText=async()=>{throw new Error('denied');};w.document.execCommand=()=>false;
  assert.equal((await n.memberCodeCopyCase()).status,'failed');
 }finally{w.close();}
});

test('QR control runner verifies both production tabs, never binds, and rejects a missing parser',async()=>{
 const d=await page('member'),w=d.window,calls=[];
 try{
  w.MemberSystem={getSession:()=>({config:{},idToken:'isolated'}),formatDate:value=>value,request:async(c,t,k,action)=>{calls.push(action);return {friends:[]};}};
  for(const file of ['member/member-growth.js','friend-qr-scanner.js','qr-scan-dialog.js','friends.js'])w.eval(read(file));
  w.dispatchEvent(new w.CustomEvent('member-profile-ready',{detail:{profile:{memberCode:'AAAA',inviteCode:'AAAA000000',lineUserId:'QA'}}}));await tick();
  const n=nodes(w),result=await n.memberQrControlsCase();assert.equal(result.status,'passed',JSON.stringify(result));
  assert.equal(w.document.getElementById('memberReferralModal').classList.contains('hidden'),true);
  assert.ok(calls.every(action=>action==='member.friend.list'));
  delete w.FriendQRScanner.parseInvitation;assert.equal((await n.memberQrControlsCase()).status,'failed');
 }finally{w.close();}
});

async function transferPage(){
 const d=await page('points'),w=d.window;
 const q={calls:[],sender:5,receiver:0,results:new Map(),friendError:false,uncertain:false};
 w.confirm=()=>true;
 w.MemberSystem={getSession:()=>({config:{},idToken:'isolated'}),request:async(c,t,k,action,p={})=>{
  q.calls.push({action,payload:{...p}});
  if(action==='points.transfer.options')return {cards:[{cardId:'QA-CARD',title:'QA',balance:q.sender}]};
  if(action==='member.friend.list'){if(q.friendError)throw new Error('好友載入失敗');return {friends:[{memberCode:'BBBB',displayName:'QA recipient',status:'accepted'},{memberCode:'CCCC',status:'pending'}]};}
  if(action==='points.transfer.receiver'){if(p.memberCode==='AAAA')throw Object.assign(new Error('不可轉贈給自己'),{status:400});return {memberCode:p.memberCode,displayName:'QA recipient'};}
  if(action==='points.transfer.create'){
   if(q.results.has(p.requestId))return q.results.get(p.requestId);
   assert.equal(p.memberCode,'BBBB');assert.equal(p.amount,2);assert.equal(q.sender,5);
   q.sender-=p.amount;q.receiver+=p.amount;const result={transferId:'QA',senderBalance:q.sender};q.results.set(p.requestId,result);
   if(q.uncertain){q.uncertain=false;throw Object.assign(new Error('Lost response'),{status:503,code:'API_RESPONSE_UNCERTAIN'});}return result;
  }
  throw new Error('Unexpected action '+action);
 }};
 w.eval(read('qr-scan-dialog.js'));
 w.eval(read('points/point-transfer.js'));
 w.document.getElementById('pointsView').classList.remove('hidden');
 w.dispatchEvent(new w.CustomEvent('user-tour:ready',{detail:{surface:'points',profile:{memberCode:'AAAA'}}}));
 w.dispatchEvent(new w.CustomEvent('pointcard:active-changed',{detail:{cardId:'QA-CARD',title:'QA',stamps:5}}));await tick();
 const get=id=>w.document.getElementById(id),fill=(id,value)=>{get(id).value=value;get(id).dispatchEvent(new w.Event('input',{bubbles:true}));};
 return {d,w,q,get,fill};
}

test('accepted friend UI filters pending friends and requires explicit transfer',async()=>{
 const {w,q,get,fill}=await transferPage();
 try{
  get('pointTransferButton').click();fill('pointTransferAmount','2');get('pointTransferChooseFriend').click();await tick();
  assert.deepEqual(Array.from(get('pointTransferFriendSelect').options,option=>option.value),['','BBBB']);
  get('pointTransferFriendSelect').value='BBBB';get('pointTransferUseFriend').click();await tick();
  assert.match(get('pointTransferReceiver').textContent,/BBBB/);assert.equal(q.sender,5);
  get('pointTransferSubmit').click();await tick();assert.match(get('pointTransferMessage').textContent,/轉贈完成/);
  assert.deepEqual([q.sender,q.receiver],[3,2]);assert.equal(q.calls.filter(call=>call.action==='points.transfer.create').length,1);
 }finally{w.close();}
});

test('uncertain transfer double-click locks recipients and reuses the same request after reopening',async()=>{
 const {w,q,get,fill}=await transferPage();
 try{
  get('pointTransferButton').click();fill('pointTransferAmount','2');fill('pointTransferMemberCode','BBBB');get('pointTransferLookup').click();await tick();
  q.uncertain=true;get('pointTransferSubmit').click();get('pointTransferSubmit').click();await tick();
  assert.match(get('pointTransferMessage').textContent,/結果尚未確認/);assert.equal(get('pointTransferMemberCode').disabled,true);
  get('pointTransferClose').click();get('pointTransferButton').click();get('pointTransferSubmit').click();await tick();
  const writes=q.calls.filter(call=>call.action==='points.transfer.create');assert.equal(writes.length,2);assert.equal(writes[0].payload.requestId,writes[1].payload.requestId);
  assert.deepEqual([q.sender,q.receiver],[3,2]);assert.equal(q.results.size,1);
 }finally{w.close();}
});

test('recipient runtime cancels without debit, fails friend fetch, and blocks self lookup',async()=>{
 const {w,q,get,fill}=await transferPage();
 try{
  const n=nodes(w),result=await n.pointsTransferRecipientControlsCase();assert.equal(result.status,'passed',JSON.stringify(result));
  assert.equal(get('pointTransferModal').classList.contains('hidden'),true);q.friendError=true;
  assert.equal((await n.pointsTransferRecipientControlsCase()).status,'failed');
  get('pointTransferButton').click();fill('pointTransferMemberCode','AAAA');get('pointTransferLookup').click();await tick();
  assert.match(get('pointTransferMessage').textContent,/不可轉贈給自己/);assert.equal(q.calls.filter(call=>call.action==='points.transfer.create').length,0);
  assert.deepEqual([q.sender,q.receiver],[5,0]);
 }finally{w.close();}
});
