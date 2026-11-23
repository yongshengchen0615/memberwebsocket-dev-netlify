const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');

function fixture(){
 const body={children:[],append(node){this.children.push(node);}};
 const document={body,createElement(tag){return {
  tag,hidden:false,children:[],textContent:'',attributes:{},
  append(...nodes){this.children.push(...nodes);},
  setAttribute(name,value){this.attributes[name]=value;}
 };}};
 const window={};
 vm.runInNewContext(read('async-action-feedback.js'),{window,document});
 return {feedback:window.AsyncActionFeedback,banner:body.children[0]};
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
 for(const page of ['member/index.html','booking/index.html','frontdesk/index.html']){
  const html=read(page);
  assert.ok(html.includes('async-action-feedback.js?v=20261123-1'),page);
  assert.ok(html.includes('async-action-feedback.css?v=20261123-1'),page);
 }
});
test('AC-005: user actions are instrumented while revision polling remains background-only',()=>{
 const fd=read('frontdesk/app.js'),bk=read('booking/app.js'),member=read('member/app.js');
 assert.ok(fd.includes('loadConflictHistory(true)'));
 assert.ok(fd.includes('正在確認預約並更新資料'));
 assert.ok(fd.includes("request('frontdesk.sync.status')"));
 assert.ok(bk.includes('正在查詢可預約時段'));
 assert.ok(bk.includes('正在送出預約並更新資料'));
 assert.ok(bk.includes('showMessage ? window.AsyncActionFeedback?.begin'));
 assert.ok(member.includes('正在儲存會員資料'));
 assert.ok(read('booking/booking-receipt.js').includes('正在安全上傳收據'));
});
