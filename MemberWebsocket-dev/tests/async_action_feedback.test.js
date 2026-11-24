const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');

function fixture(){
 const body={children:[],append(node){this.children.push(node);}};
 const listeners=new Map();
 const document={body,addEventListener(type,listener){listeners.set(type,listener);},createElement(tag){return {
  tag,hidden:false,children:[],textContent:'',attributes:{},
  append(...nodes){this.children.push(...nodes);},
  setAttribute(name,value){this.attributes[name]=value;}
 };}};
 const window={};
 vm.runInNewContext(read('async-action-feedback.js'),{window,document});
 const interactive={tag:'main',inert:false};
 body.children.push(interactive);
 return {feedback:window.AsyncActionFeedback,banner:body.children[0],interactive,listeners};
}

test('AC-001: action displays an accessible Loading status and releases idempotently',()=>{
 const {feedback,banner}=fixture();
 assert.equal(banner.hidden,true);
 const end=feedback.begin('正在查詢…');
 assert.equal(banner.hidden,false);
 assert.equal(banner.attributes.role,'status');
 assert.equal(banner.children[1].textContent,'正在查詢…');
 end();end();
 assert.equal(banner.hidden,true);
 assert.equal(banner.children[1].textContent,'');
});
test('AC-002: overlapping actions keep the status visible until the last finishes',()=>{
 const {feedback,banner}=fixture();
 const first=feedback.begin('第一筆請求…');
 const second=feedback.begin('第二筆請求…');
 first();
 assert.equal(banner.hidden,false);
 assert.equal(banner.children[1].textContent,'第二筆請求…');
 second();
 assert.equal(banner.hidden,true);
});
test('AC-003: completion and failure always clear the pending indicator',async()=>{
 const {feedback,banner}=fixture();
 let resolve;
 const deferred=new Promise(r=>{resolve=r;});
 const work=feedback.track('處理中…',()=>deferred);
 assert.equal(banner.hidden,false);
 resolve(7);
 assert.equal(await work,7);
 assert.equal(banner.hidden,true);
 await assert.rejects(feedback.track('儲存中…',()=>Promise.reject(Error('network'))),/network/);
 assert.equal(banner.hidden,true);
});
test('AC-004: member, booking and frontdesk load the shared versioned assets',()=>{
 for(const page of ['member/index.html','booking/index.html','frontdesk/index.html','points/index.html','event/index.html','calendar/index.html']){
  const html=read(page);
  assert.ok(html.includes('async-action-feedback.js?v=20261124-1'),page);
  assert.ok(html.includes('async-action-feedback.css?v=20261124-1'),page);
 }
});
test('AC-005: user actions are instrumented while revision polling remains background-only',()=>{
 const fd=read('frontdesk/app.js'),bk=read('booking/app.js'),member=read('member/app.js');
 assert.ok(fd.includes('loadConflictHistory(true)'));
 assert.ok(fd.includes('正在確認預約並同步最新資料'));
 assert.ok(fd.includes('正在拒絕預約並同步最新資料'));
 assert.ok(fd.includes("confirmFrontdeskReview(booking,'confirmed')"));
 assert.ok(fd.includes("confirmFrontdeskReview(booking,'rejected'"));
 assert.ok(fd.includes("request('frontdesk.sync.status')"));
 assert.ok(bk.includes('正在查詢可預約時段'));
 assert.ok(bk.includes('正在送出預約並更新資料'));
 assert.ok(bk.includes('showMessage ? window.AsyncActionFeedback?.begin'));
 assert.ok(member.includes('正在儲存會員資料'));
 assert.ok(read('booking/booking-receipt.js').includes('正在安全上傳收據'));
 assert.ok(read('points/point-transfer.js').includes('正在安全轉贈點數並更新餘額'));
 assert.ok(read('points/pointcard-ticket-overview.js').includes('正在核銷集點票券'));
 assert.ok(read('event/app.js').includes('正在核銷活動票券並更新資料'));
 assert.ok(read('ticket-booking-selections.js').includes('正在儲存預約票券並同步資料'));
 assert.ok(read('friends.js').includes('正在更新好友關係'));
});

// Regression: the former bottom toast showed progress but did not stop accidental clicks.
test('AC-006: shared Loading matches the admin fullscreen blocking overlay',()=>{
 const css=read('async-action-feedback.css');
 assert.match(css,/\.async-action-feedback\s*\{[^}]*position:\s*fixed/s);
 assert.match(css,/\.async-action-feedback\s*\{[^}]*inset:\s*0/s);
 assert.match(css,/\.async-action-feedback\s*\{[^}]*pointer-events:\s*auto/s);
 assert.match(css,/background:\s*rgba\(13,\s*22,\s*32,\s*\.62\)/);
 assert.match(css,/z-index:\s*2147483000/);
});

test('AC-007: background controls cannot be clicked, submitted, or keyboard-activated until every operation finishes',()=>{
 const {feedback,interactive,listeners}=fixture();
 const first=feedback.begin('正在送出預約…');
 const second=feedback.begin('正在同步資料…');
 assert.equal(interactive.inert,true,'underlying content must be inert');
 for(const type of ['click','submit','keydown']){
  const handler=listeners.get(type);
  assert.equal(typeof handler,'function',`${type} must have a capture guard`);
  const event={target:interactive,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};
  handler(event);
  assert.equal(event.prevented,true,`${type} must be cancelled`);
  assert.equal(event.stopped,true,`${type} must not reach the old handler`);
 }
 first();
 assert.equal(interactive.inert,true,'first completion must not unlock another pending operation');
 second();
 assert.equal(interactive.inert,false,'the original inert state must be restored');
 const event={target:interactive,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};
 listeners.get('click')(event);
 assert.equal(event.prevented,false,'normal interactions must resume');
});

test('AC-008: failed operations restore the original disabled/inert state',async()=>{
 const {feedback,interactive}=fixture();
 interactive.inert=true;
 await assert.rejects(feedback.track('請稍候…',()=>Promise.reject(Error('NETWORK'))),/NETWORK/);
 assert.equal(interactive.inert,true);
});
