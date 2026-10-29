const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../admin/booking-risk.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const policy={enabled:false,version:3,threshold_count:2,lookback_days:30,duration_count:1,duration_unit:'months',grace_minutes:15,appeal_enabled:true,contact_text:'合成客服',updated_at:'2026-10-25T02:00:00Z'};
function setup(request,data={policy,events:[],restrictions:[],appeals:[]}){
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window;
 const confirmations=[],calls=[];let consent=false;
 w.confirm=message=>{confirmations.push(message);return consent;};
 w.eval(source);w.BookingRiskSettings.mount(w.document.querySelector('main'),{data,request:async(action,body)=>{calls.push({action,body});return request(action,body);}});
 const root=w.document.querySelector('#bookingRiskSettings');
 return{dom,w,root,calls,confirmations,consent:value=>consent=value,button:label=>[...root.querySelectorAll('button')].find(b=>b.textContent===label),submit:()=>root.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}))};
}
test('AC-RISK-UX-002/003: enable and disable require readable consent; cancellation preserves draft and writes nothing',async()=>{
 const h=setup(async(_action,body)=>({policy:{...body.policy,version:4},events:[],restrictions:[],appeals:[]}));
 try{
  h.root.querySelector('[name=enabled]').click();h.submit();await tick();
  assert.equal(h.calls.length,0,'cancelling policy confirmation must not write');
  assert.match(h.confirmations[0],/30 天內達到 2 次/);assert.match(h.confirmations[0],/不追溯/);assert.match(h.confirmations[0],/新線上預約/);
  assert.equal(h.root.querySelector('[name=enabled]').checked,true);
  h.consent(true);h.submit();await tick();assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.policy.version,3);
  h.consent(false);h.root.querySelector('[name=enabled]').click();h.submit();await tick();
  assert.equal(h.calls.length,1);assert.match(h.confirmations.at(-1),/暫停執行/);assert.match(h.confirmations.at(-1),/紀錄不刪除/);
 }finally{h.dom.window.close();}
});
test('AC-RISK-UX-005/006/009: each action confirms exact target, reason and effect; cancel restores focus without a write',async()=>{
 const data={policy,events:[{booking_id:'booking-A',member_id:'member-A',member_code:'QA-A',occurred_at:'2026-10-24T00:00:00Z'}],restrictions:[{id:'restriction-A',member_id:'member-A',member_code:'QA-A',source_booking_id:'booking-A',starts_at:'2026-10-24T00:00:00Z',ends_at:'2099-01-01T00:00:00Z'}],appeals:[{id:'appeal-A',member_id:'member-A',member_code:'QA-A',restriction_id:'restriction-A',reason:'合成申覆',created_at:'2026-10-25T00:00:00Z'}]};
 const h=setup(async()=>data,data);
 try{
  for(const [label,target,effect]of [['撤銷誤判','booking-A',/撤銷.*計次/],['人工解除','restriction-A',/保留.*計次/]]){
   const reason=h.root.querySelector('[name=action_reason]');assert.ok(reason,'action reason must be addressable');reason.value='合成核對理由';
   const button=h.button(label);button.focus();button.click();await tick();
   assert.equal(h.calls.length,0);assert.match(h.confirmations.at(-1),new RegExp(target));assert.match(h.confirmations.at(-1),/QA-A/);assert.match(h.confirmations.at(-1),/合成核對理由/);assert.match(h.confirmations.at(-1),effect);
   assert.equal(h.w.document.activeElement,button);assert.equal(reason.value,'合成核對理由');
  }
  h.consent(true);h.button('人工解除').click();await tick();assert.equal(h.calls.length,1);assert.equal(h.calls[0].action,'release');
  assert.match(h.root.querySelector('[role=status]').textContent,/人工解除/);assert.equal(h.button('記錄回覆'),undefined);
 }finally{h.dom.window.close();}
});
test('AC-RISK-UX-007: version conflict freezes stale writes and reload requires explicit draft discard',async()=>{
 const h=setup(async(action)=>{if(action==='save')throw Object.assign(Error('其他管理員已更新政策'),{code:'BOOKING_CONFLICT'});return{policy:{...policy,version:9,threshold_count:4},events:[],restrictions:[],appeals:[]};});
 try{
  h.consent(true);h.root.querySelector('[name=enabled]').click();h.submit();await tick();
  assert.equal(h.calls.length,1);assert.equal(h.button('儲存政策').disabled,true);
  assert.equal(h.root.querySelector('[name=threshold_count]').value,'2');
  h.submit();await tick();assert.equal(h.calls.length,1,'must not silently retry stale version');
  const reload=h.root.querySelector('[data-risk-refresh]');assert.ok(reload);h.consent(false);reload.click();await tick();assert.equal(h.calls.length,1);
  h.consent(true);reload.click();await tick();assert.equal(h.calls.length,2);assert.equal(h.calls[1].action,'get');
  assert.equal(h.root.querySelector('[name=threshold_count]').value,'4');assert.equal(h.button('儲存政策').disabled,false);
  assert.equal(h.w.document.activeElement,h.root.querySelector('[data-risk-refresh]'));
 }finally{h.dom.window.close();}
});
test('AC-RISK-UX-007: failed reload keeps stale policy locked until a successful explicit reload',async()=>{
 let reads=0;
 const h=setup(async action=>{
  if(action==='save')throw Object.assign(Error('其他管理員已更新政策'),{code:'BOOKING_CONFLICT'});
  if(++reads===1)throw Error('重新載入網路中斷');
  return{policy:{...policy,version:9},events:[],restrictions:[],appeals:[]};
 });
 try{
  h.consent(true);h.root.querySelector('[name=enabled]').click();h.submit();await tick();
  h.root.querySelector('[data-risk-refresh]').click();await tick();
  assert.equal(h.button('儲存政策').disabled,true);assert.equal(h.button('還原變更').disabled,true);
  h.submit();await tick();assert.deepEqual(h.calls.map(call=>call.action),['save','get']);
  h.root.querySelector('[data-risk-refresh]').click();await tick();assert.deepEqual(h.calls.map(call=>call.action),['save','get','get']);
  assert.equal(h.button('儲存政策').disabled,false);assert.equal(h.root.querySelector('[name=enabled]').checked,false);
 }finally{h.dom.window.close();}
});
test('AC-RISK-UX-001/004/009: invalid fields are announced and records expose safe target/time/history context',()=>{
 const data={policy,events:[{booking_id:'booking-A',member_id:'member-A',member_code:'<img src=x>',occurred_at:'2026-10-24T00:00:00Z',revoked_at:'2026-10-25T00:00:00Z',revoke_reason:'合成誤判'}],restrictions:[{id:'restriction-A',member_code:'QA-A',source_booking_id:'booking-A',starts_at:'2026-10-01T00:00:00Z',ends_at:'2026-10-02T00:00:00Z',revoked_at:'2026-10-01T12:00:00Z',revoke_reason:'合成解除'}],appeals:[{id:'appeal-A',member_code:'QA-A',restriction_id:'restriction-A',source_booking_id:'booking-A',reason:'合成申覆',created_at:'2026-10-01T00:00:00Z',resolved_at:'2026-10-01T12:00:00Z',resolution:'合成回覆'}]};
 const h=setup(async()=>assert.fail('invalid input must not write'),data);
 try{
  assert.equal(h.root.querySelectorAll('img').length,0);assert.match(h.root.textContent,/booking-A/);assert.match(h.root.textContent,/restriction-A/);assert.match(h.root.textContent,/台北/);
  for(const text of ['合成誤判','合成解除','已撤銷'])assert.ok(h.root.textContent.includes(text),text);
  assert.equal(h.button('人工解除'),undefined);
  assert.doesNotMatch(h.root.textContent,/合成申覆|合成回覆/);
  h.root.querySelector('[name=enabled]').click();h.root.querySelector('[name=threshold_count]').value='101';h.submit();
  const input=h.root.querySelector('[name=threshold_count]');assert.equal(input.getAttribute('aria-invalid'),'true');
  const message=h.w.document.getElementById(input.getAttribute('aria-describedby'));assert.match(message.textContent,/1.*100/);assert.equal(h.w.document.activeElement,input);
 }finally{h.dom.window.close();}
});
test('AC-RISK-UX-008: marking no-show explains actual policy counting and preserves the ticket/points contract',()=>{
 const core=fs.readFileSync(path.resolve(__dirname,'../../admin/booking-panel-core.js'),'utf8');
 const chunk=core.slice(core.indexOf('  function openNoShow('),core.indexOf('  async function updateBookingStatus('));
 const dom=new JSDOM('<h2 id="title"></h2><main></main>',{runScripts:'outside-only'}),w=dom.window;
 try{
  w.eval(`const state={busy:false,booking:{noShowRisk:{policy:{enabled:true,grace_minutes:15}}}};const els={bookingAdminCrudModalTitle:document.getElementById('title'),bookingAdminCrudModalBody:document.querySelector('main')};function noShowUnavailableReason(){return '';}function escapeHtml(value){const n=document.createElement('span');n.textContent=value;return n.innerHTML;}function closeModal(){}function showModal(){};${chunk};window.openRiskNoShow=openNoShow;`);
  w.openRiskNoShow({bookingId:'booking-A',memberCode:'QA-A',startAt:'2026-10-24T09:00:00',endAt:'2026-10-24T10:00:00'},'');
  const text=w.document.querySelector('main').textContent;assert.match(text,/15 分鐘/);assert.match(text,/依.*政策計次/);assert.doesNotMatch(text,/不計入違規/);assert.match(text,/不核銷票券、不扣點/);assert.match(text,/booking-A/);
 }finally{w.close();}
});
test('AC-RISK-UX-004: incomplete or impossible restriction dates never expose an active release action',()=>{
 const data={policy,events:[],appeals:[],restrictions:[
  {id:'missing-start',ends_at:'2099-01-01T00:00:00Z'},
  {id:'invalid-start',starts_at:'invalid',ends_at:'2099-01-01T00:00:00Z'},
  {id:'reversed',starts_at:'2099-01-02T00:00:00Z',ends_at:'2099-01-01T00:00:00Z'},
 ]};
 const h=setup(async()=>assert.fail('malformed record must not be actionable'),data);
 try{assert.equal(h.button('人工解除'),undefined);assert.equal(h.root.querySelectorAll('.booking-risk-metric strong')[1].textContent,'0');assert.match(h.root.textContent,/期限資料不完整/);}
 finally{h.dom.window.close();}
});
