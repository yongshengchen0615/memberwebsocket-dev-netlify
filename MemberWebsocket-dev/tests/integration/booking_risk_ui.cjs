const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
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
