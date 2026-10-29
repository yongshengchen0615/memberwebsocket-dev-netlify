const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../admin/booking-risk.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(data,request){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window;w.confirm=()=>true;
 w.eval(source);w.BookingRiskSettings.mount(w.document.querySelector('main'),{data,request});
 return {dom,w,root:w.document.querySelector('#bookingRiskSettings')};
}
const sample={policy:{enabled:false,version:1},events:[],restrictions:[],appeals:[]};
test('AC-RISK-UX-005: grouped settings, live summary and empty states without auto-enabling policy',()=>{
 const {dom,w,root}=setup(sample,async()=>{throw Error('unexpected request');});
 try{
  assert.equal(root.querySelectorAll('.booking-risk-metric').length,3);
  assert.equal(root.querySelectorAll('.booking-risk-field-group').length,4);
  assert.equal(root.querySelectorAll('.booking-risk-record-section').length,2);
  assert.equal(root.querySelectorAll('.booking-risk-record-tools label').length,1);
  assert.equal(root.querySelectorAll('.booking-risk-record-section .booking-risk-record-list').length,2);
  for(const text of ['目前沒有爽約計次紀錄。','目前沒有有效限制紀錄。'])assert.ok(root.textContent.includes(text));
  assert.equal(root.querySelector('[name=enabled]').checked,false);
  assert.equal(root.querySelector('[name=threshold_count]').value,'');
  assert.match(root.querySelector('.booking-risk-preview').textContent,/限制未啟用/);
  root.querySelector('[name=enabled]').click();
  for(const [key,value] of Object.entries({lookback_days:'90',threshold_count:'3',grace_minutes:'15',duration_count:'2',duration_unit:'weeks',contact_text:'測試客服'})){
   const input=root.querySelector('[name='+key+']');input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));
  }
  assert.match(root.querySelector('.booking-risk-preview').textContent,/90 天內達到 3 次/);
  assert.match(root.querySelector('.booking-risk-draft').textContent,/未儲存/);
  const discard=[...root.querySelectorAll('button')].find(b=>b.textContent==='還原變更');
  assert.equal(discard.disabled,false);discard.click();
  assert.equal(root.querySelector('[name=enabled]').checked,false);
  assert.equal(root.querySelector('[name=threshold_count]').value,'');
  assert.equal(root.querySelectorAll('[role=status]').length,1);
 }finally{dom.window.close();}
});
test('AC-RISK-UX-006: unsaved data survives refresh attempt and failed save; ranges rejected',async()=>{
 const calls=[],{dom,w,root}=setup(sample,async(action,body)=>{calls.push({action,body});throw Error('合成網路錯誤');});
 try{
  root.querySelector('[name=enabled]').click();
  [...root.querySelectorAll('button')].find(b=>b.textContent==='更新紀錄').click();
  assert.equal(calls.length,0);assert.match(root.querySelector('[role=status]').textContent,/未儲存/);
  for(const [key,value] of Object.entries({lookback_days:'90',threshold_count:'101',grace_minutes:'15',duration_count:'2',duration_unit:'weeks',contact_text:'測試客服'}))root.querySelector('[name='+key+']').value=value;
  root.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(calls.length,0);assert.match(root.querySelector('[role=status]').textContent,/有效範圍/);
  root.querySelector('[name=threshold_count]').value='3';
  root.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await tick();
  assert.equal(calls.length,1);assert.equal(calls[0].action,'save');
  assert.equal(calls[0].body.policy.version,1);
  assert.equal(root.querySelector('[name=threshold_count]').value,'3');
  assert.match(root.querySelector('[role=status]').textContent,/輸入內容已保留/);
  assert.equal(root.getAttribute('aria-busy'),'false');
 }finally{dom.window.close();}
});
test('AC-RISK-UX-007: verified refresh renders counts and action reason stays required',async()=>{
 const calls=[],next={policy:{enabled:false,version:2},events:[{booking_id:'synthetic',member_code:'TEST',occurred_at:'2026-10-01T00:00:00Z'}],restrictions:[],appeals:[{id:'appeal',reason:'合成申覆',resolved_at:null}]};
 const {dom,root}=setup(sample,async(action,body)=>{calls.push({action,body});return next;});
 try{
  [...root.querySelectorAll('button')].find(b=>b.textContent==='更新紀錄').click();
  await tick();assert.equal(calls[0].action,'get');
  assert.equal(root.querySelectorAll('.booking-risk-metric strong')[2].textContent,'1');
  assert.equal(root.querySelectorAll('.booking-risk-record-section').length,2);
  assert.equal(root.querySelectorAll('[data-risk-action=resolve]').length,0);
  assert.doesNotMatch(root.textContent,/申覆/);
 }finally{dom.window.close();}
});
