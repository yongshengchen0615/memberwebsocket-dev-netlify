const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
test('AC-RISK-UX-004: failed action preserves reason and can retry; all writes are locked while pending',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window;
 try{
  w.eval(fs.readFileSync(path.resolve(__dirname,'../../admin/booking-risk.js'),'utf8'));
  let rejectRequest;const calls=[],data={policy:{enabled:false,version:1},events:[{booking_id:'synthetic-id',member_code:'SYNTHETIC',occurred_at:'2026-01-01T00:00:00Z'}],restrictions:[{id:'synthetic-restriction',ends_at:'2099-01-01T00:00:00Z'}]};
  w.BookingRiskSettings.mount(w.document.querySelector('main'),{data,request:(action,body)=>{calls.push({action,body});return new Promise((_resolve,reject)=>{rejectRequest=reject;});}});
  const reason=[...w.document.querySelectorAll('label')].find(label=>label.textContent.includes('撤銷／解除／回覆原因')).querySelector('input');reason.value='核對後撤銷';
  const revoke=[...w.document.querySelectorAll('button')].find(b=>b.textContent==='撤銷誤判'),release=[...w.document.querySelectorAll('button')].find(b=>b.textContent==='人工解除');
  revoke.click();assert.equal(release.disabled,true,'other actions must lock during request');release.click();assert.equal(calls.length,1);
  rejectRequest(Error('暫時失敗'));await new Promise(r=>setImmediate(r));
  assert.equal(revoke.disabled,false,'failed action must become retryable');assert.equal(reason.value,'核對後撤銷');assert.match(w.document.querySelector('[role=status]').textContent,/暫時失敗/);
  revoke.click();assert.equal(calls.length,2);assert.equal(calls[1].body.reason,calls[0].body.reason);
  rejectRequest(Error('第二次失敗'));await new Promise(r=>setImmediate(r));
 }finally{w.close();}
});
test('AC-173 UI: blank policy remains off; enabling requires chosen values and reasons are required for revocation',async()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window;
 try{
  w.eval(fs.readFileSync(path.resolve(__dirname,'../../admin/booking-risk.js'),'utf8'));
  const calls=[],data={policy:{enabled:false,appeal_enabled:true,version:1},events:[{booking_id:'synthetic-id',member_code:'SYNTHETIC',occurred_at:'2026-01-01T00:00:00Z'}]};
  w.BookingRiskSettings.mount(w.document.querySelector('main'),{data,request:async(action,body)=>{calls.push({action,body});return data;}});
  assert.equal(w.document.querySelector('[name=enabled]').checked,false);
  assert.equal(w.document.querySelector('[name=threshold_count]').value,'');
  w.document.querySelector('[name=enabled]').checked=true;
  w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(calls.length,0);
  assert.ok(w.document.querySelector('[role=status]').textContent.includes('完整設定'));
  const values={threshold_count:'3',lookback_days:'90',duration_count:'2',duration_unit:'weeks',grace_minutes:'15',contact_text:'合成客服'};
  for(const [key,value]of Object.entries(values))w.document.querySelector(`[name=${key}]`).value=value;
  w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setImmediate(r));
  assert.equal(calls[0].action,'save');assert.equal(calls[0].body.policy.duration_unit,'weeks');assert.equal(calls[0].body.policy.enabled,true);
  [...w.document.querySelectorAll('button')].find(b=>b.textContent==='撤銷誤判').click();assert.equal(calls.length,1);
  assert.ok(w.document.querySelector('[role=status]').textContent.includes('原因'));
 }finally{w.close();}
});
test('AC-173 member UI: exact expiry, permitted existing edits, safe contact text and authenticated appeal payload',async()=>{
 const dom=new JSDOM('<form id="bookingForm"></form>',{runScripts:'outside-only'}),w=dom.window;
 try{
  const source=fs.readFileSync(path.resolve(__dirname,'../../booking/app.js'),'utf8');
  const chunk=source.slice(source.indexOf('  function bookingRestricted() {'),source.indexOf('  function renderMemberProfile() {'));
  const now=Date.parse('2026-10-21T00:00:00Z');const calls=[];
  w.BookingSystem={request:async(config,client,idToken,action,body)=>{calls.push({config,client,idToken,action,body});return{restricted:true,expiresAt:'2026-10-22T00:00:00Z',appealEnabled:true,appealSubmitted:true};}};
  w.eval(`const state={config:{business:'synthetic'},idToken:'verified-fixture',editing:null,data:{bookingRestriction:{restricted:true,expiresAt:'2026-10-22T00:00:00Z',appealEnabled:true,contactText:'<img src=x onerror=alert(1)>電話客服'}}};const els={bookingForm:document.getElementById('bookingForm')};function currentServerTimeMs(){return ${now};}${chunk};window.riskState=state;window.riskRestricted=bookingRestricted;window.riskRender=renderBookingRestriction;`);
  assert.equal(w.riskRestricted(),true);w.riskRender();assert.equal(w.document.querySelectorAll('img').length,0);assert.ok(w.document.getElementById('bookingRestrictionNotice').textContent.includes('電話客服'));
  w.document.querySelector('button').click();assert.equal(calls.length,0);
  w.document.querySelector('textarea').value='請核對預約紀錄';w.document.querySelector('button').click();await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,1);assert.equal(calls[0].client,'member');assert.equal(calls[0].idToken,'verified-fixture');assert.equal(calls[0].action,'user.booking.risk.appeal');assert.deepEqual(Object.keys(calls[0].body),['reason']);
  assert.ok(w.document.getElementById('bookingRestrictionNotice').textContent.includes('申覆已送出'));
  w.riskState.editing={bookingId:'existing'};assert.equal(w.riskRestricted(),false);
  w.riskState.editing=null;w.riskState.data.bookingRestriction.expiresAt=new Date(now).toISOString();assert.equal(w.riskRestricted(),false);w.riskRender();assert.equal(w.document.getElementById('bookingRestrictionNotice'),null);
 }finally{w.close();}
});
