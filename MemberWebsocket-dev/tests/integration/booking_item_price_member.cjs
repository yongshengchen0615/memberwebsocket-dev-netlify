const {test}=require('node:test');const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const pause=()=>new Promise(resolve=>setImmediate(resolve));
test('AC-006: a price changed after confirmation was opened preserves the draft and requires reconfirmation',async()=>{
 const dom=new JSDOM(fs.readFileSync(root+'/booking/index.html','utf8'),{runScripts:'outside-only',url:'https://example.test/booking/'});const w=dom.window;
 const id='20000000-0000-4000-8000-000000000001',v1='30000000-0000-4000-8000-000000000001',v2='30000000-0000-4000-8000-000000000002';
 const booking={bookingId:'40000000-0000-4000-8000-000000000001',updatedAt:'2026-09-11T00:00:00Z',status:'confirmed',bookingDate:'2099-01-01',startTime:'09:00',endTime:'10:00',memberNote:'保留草稿',items:[{serviceId:id,serviceTitle:'Fixture service',unitDurationMinutes:60,unitPriceAmount:500,quantity:1}]};
 const data={today:'2026-09-11',settings:{minAdvanceDays:0,workStartTime:'09:00',workEndTime:'18:00'},services:[{serviceId:id,title:'Fixture service',durationMinutes:60,priceAmount:500,priceVersion:v1,isActive:true}],bookings:[booking]};
 const writes=[];
 w.BookingSystem={loadConfig:async()=>({pricePublishing:true}),signIn:async()=>'fixture-token',subscribeRealtime:()=>()=>{},memberProfile:async()=>({}),addDays:(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10),formatDate:x=>x,request:async(c,t,token,action,payload)=>{
  if(action==='user.booking.bootstrap')return structuredClone(data);
  if(action==='user.booking.slots')return {slots:[{startTime:'10:00',endTime:'11:10',startAt:'2099-01-01T10:00:00+08:00',endAt:'2099-01-01T11:10:00+08:00',available:true}]};
  if(action==='user.booking.update'){
   writes.push(payload);
   if(payload.expectedPrices?.[0]?.priceVersion!==v2)throw Object.assign(Error('價格已變更'),{code:'BOOKING_PRICE_CHANGED'});
   return {booking:{...booking,...payload,status:'pending'}};
  }
  throw Error(action);
 }};
 try{
  w.eval(fs.readFileSync(root+'/booking-price-publishing.js','utf8'));w.eval(fs.readFileSync(root+'/booking/app.js','utf8'));
  const click=text=>{const b=[...w.document.querySelectorAll('button')].find(x=>x.textContent===text);assert.ok(b,text);b.click();};
  for(let i=0;i<30&&!w.document.getElementById('bookingList')?.textContent.includes('修改預約');i++)await pause();
  click('修改預約');for(let i=0;i<20&&!w.document.querySelector('#slotGrid .slot-button');i++)await pause();
  click('10:00–11:10');w.document.getElementById('bookingForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
  assert.match(w.document.getElementById('bookingConfirmSummary').textContent,/500/);
  data.services[0].priceAmount=800;data.services[0].priceVersion=v2;
  click('確認送出');for(let i=0;i<30&&!w.document.getElementById('bookingConfirmMessage').textContent.includes('價格已更新');i++)await pause();
  assert.equal(writes.length,1);assert.equal(writes[0].expectedPrices[0].priceVersion,v1,'send the displayed quote, not the most recently fetched catalog');
  assert.equal(w.document.getElementById('memberNote').value,'保留草稿');
  assert.equal(w.document.getElementById('bookingConfirmModal').classList.contains('hidden'),true,'refresh preserves the existing requirement to reselect a fresh available slot');
  click('10:00–11:10');w.document.getElementById('bookingForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
  assert.match(w.document.getElementById('bookingConfirmSummary').textContent,/800/);
  click('確認送出');for(let i=0;i<30&&writes.length<2;i++)await pause();
  assert.equal(writes[1].expectedPrices[0].priceAmount,800);assert.equal(writes[1].expectedPrices[0].priceVersion,v2);
 }finally{w.close();}
});
