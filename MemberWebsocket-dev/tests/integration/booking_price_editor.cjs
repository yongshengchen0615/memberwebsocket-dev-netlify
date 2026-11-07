const {test}=require('node:test');const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const fs=require('node:fs'),path=require('node:path');
const source=path.resolve(__dirname,'../../admin/booking-price-editor.js');
const service={serviceId:'10000000-0000-4000-8000-000000000001',title:'肩頸服務',priceAmount:500,priceVersion:'20000000-0000-4000-8000-000000000001'};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(onWrite){
 const dom=new JSDOM('<button id="opener">調整價格</button>',{url:'https://example.test/admin/',runScripts:'outside-only'});
 const w=dom.window;const calls=[];let saved=0;
 w.confirm=()=>true;w.document.getElementById('opener').focus();
 w.eval(fs.readFileSync(source,'utf8'));
 await w.BookingPriceEditor.open({service,request:async(action,payload)=>{calls.push({action,payload});if(action.endsWith('.catalog'))return {publications:[]};return onWrite?onWrite(action,payload):{publication:{id:'price-1'}};},onSaved:async()=>saved++});
 return{dom,w,calls,get saved(){return saved},close:()=>w.close()};
}
test('AC-002/011: item price dialog shows current price and immediately publishes only that item',async()=>{
 const h=await setup();try{
  const d=h.w.document;assert.match(d.querySelector('[role="dialog"]').textContent,/肩頸服務.*目前價格.*500/s);
  d.querySelector('[name="priceAmount"]').value='800';
  d.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
  const call=h.calls.find(x=>x.action.endsWith('.publish'));
  assert.equal(call.payload.serviceId,service.serviceId);assert.equal(call.payload.priceAmount,800);assert.equal(call.payload.mode,'immediate');
  assert.equal(call.payload.expectedPriceVersion,service.priceVersion);assert.equal(h.saved,1);
  assert.equal(d.querySelector('[role="dialog"]'),null);
 }finally{h.close()}
});
test('AC-003: local datetime explicitly represents Taipei, independent of browser timezone',async()=>{
 const h=await setup();try{
  const d=h.w.document;const mode=d.querySelector('[name="mode"]');mode.value='scheduled';mode.dispatchEvent(new h.w.Event('change'));
  d.querySelector('[name="priceAmount"]').value='900';d.querySelector('[name="publishAt"]').value='2035-11-10T09:30';
  d.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
  assert.equal(h.calls.find(x=>x.action.endsWith('.publish')).payload.publishAt,'2035-11-10T09:30:00+08:00');
 }finally{h.close()}
});
test('AC-005/011: server conflict preserves draft, re-enables submit and supports Escape focus return',async()=>{
 const h=await setup(()=>{throw Object.assign(Error('價格已被更新'),{code:'BOOKING_PRICE_CHANGED'})});try{
  const d=h.w.document;d.querySelector('[name="priceAmount"]').value='777';d.querySelector('form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await flush();
  assert.equal(d.querySelector('[name="priceAmount"]').value,'777');assert.match(d.querySelector('[role="status"]').textContent,/價格已被更新/);
  assert.equal(d.querySelector('[type="submit"]').disabled,false);assert.equal(h.saved,0);
  d.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(d.querySelector('[role="dialog"]'),null);assert.equal(d.activeElement.id,'opener');
 }finally{h.close()}
});
