const {test}=require('node:test');const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');const fs=require('node:fs');const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../ticket-booking-choice.js'),'utf8');
const booking=(id,title='QA service')=>({bookingId:id,bookingDate:'2099-01-01',startTime:'10:00',title});
function fixture(){const dom=new JSDOM('<main id="choice"></main>',{runScripts:'outside-only'});dom.window.eval(source);return {dom,choice:dom.window.document.getElementById('choice'),api:dom.window.TicketBookingChoice};}
test('batch choices require one booking eligible for every ticket',()=>{const {dom,api}=fixture();try{assert.deepEqual(Array.from(api.common([{eligibleBookings:[booking('A'),booking('B')]},{eligibleBookings:[booking('B'),booking('C')]}]),b=>b.bookingId),['B']);assert.equal(api.common([{eligibleBookings:[booking('A')]},{eligibleBookings:[]}]).length,0);assert.equal(api.common([]).length,0);}finally{dom.window.close();}});
test('several eligible bookings require an explicit choice and busy selector is locked',()=>{const {dom,choice,api}=fixture();try{let changes=0;api.mount(choice,[booking('A'),booking('B')],()=>changes++);assert.equal(api.selected(choice),'');const select=choice.querySelector('select');select.value='B';select.dispatchEvent(new dom.window.Event('change'));assert.equal(changes,1);assert.equal(api.selected(choice),'B');api.lock(choice,true);assert.equal(select.disabled,true);api.lock(choice,false);assert.equal(select.disabled,false);}finally{dom.window.close();}});
test('refresh preserves a valid choice and removes an outdated booking',()=>{const {dom,choice,api}=fixture();try{api.mount(choice,[booking('A')]);assert.equal(api.selected(choice),'A');api.mount(choice,[booking('A'),booking('B')]);assert.equal(api.selected(choice),'A');api.mount(choice,[]);assert.equal(api.selected(choice),'');assert.match(choice.textContent,/沒有符合條件/);}finally{dom.window.close();}});
test('booking titles render as text without injecting markup',()=>{const {dom,choice,api}=fixture();try{api.mount(choice,[booking('A','<img src=x onerror="alert(1)">')]);assert.equal(choice.querySelectorAll('img').length,0);assert.match(choice.textContent,/<img/);assert.equal(choice.querySelector('select').getAttribute('aria-label'),'本次使用的預約');}finally{dom.window.close();}});
async function pointFixture(eligibleBookings){
 const dom=new JSDOM('<main id="ticketList"></main>',{runScripts:'outside-only',url:'https://qa.local/'}),w=dom.window,calls=[];
 w.eval(fs.readFileSync(path.join(__dirname,'../../ui-components.js'),'utf8'));w.eval(source);w.eval(fs.readFileSync(path.join(__dirname,'../../points/pointcard-ticket-overview.js'),'utf8'));
 w.fetch=async(_url,options)=>{const payload=JSON.parse(options.body);calls.push(payload);return {ok:payload.operation==='member.settings.get',json:async()=>payload.operation==='member.settings.get'?{ok:true,data:{maxTicketsPerRedemption:0}}:{ok:false,error:{code:'API_RESPONSE_UNCERTAIN',message:'QA uncertain'}}};};
 await w.PointCardTicketOverview.initialize({config:{supabaseUrl:'https://fixture.supabase.co',supabasePublishableKey:'fixture'},idToken:'fixture'});
 const card={cardId:'CARD',title:'QA Card',status:'active',stamps:20,rewards:[{thresholdStamps:5,ticketTemplateId:'template'}]};
 w.PointCardTicketOverview.renderSnapshot({cards:[card],cardDetails:{CARD:{card,tickets:[{ticketId:'POINT',ticketTemplateId:'template',thresholdStamps:5,ticketTitle:'QA coupon',status:'available',eligibleBookings}]}}});
 return {dom,w,calls};
}
test('real points overview disables a held ticket without an eligible confirmed booking',async()=>{const {dom,w,calls}=await pointFixture([]);try{assert.equal(w.document.querySelector('[data-ticket-select]').disabled,true);assert.match(w.document.getElementById('ticketList').textContent,/需先有已確認/);assert.equal(calls.filter(c=>c.operation==='member.redeem').length,0);}finally{dom.window.close();}});
test('real points modal requires booking selection and retries the identical usage request',async()=>{const {dom,w,calls}=await pointFixture([booking('A'),booking('B')]);try{
 const doc=w.document,check=doc.querySelector('[data-ticket-select]');check.checked=true;check.dispatchEvent(new w.Event('change',{bubbles:true}));doc.querySelector('.ticket-overview-use').click();
 const button=doc.querySelector('.ticket-batch-confirm'),select=doc.querySelector('[data-ticket-booking-choice] select');assert.equal(button.disabled,true);
 select.value='B';select.dispatchEvent(new w.Event('change'));assert.equal(button.disabled,false);
 const wait=async()=>{for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,1));if(button.textContent==='重新確認')return;}throw Error('Retry state not reached');};
 button.click();await wait();assert.match(doc.querySelector('[data-batch-message]').textContent,/QA uncertain/);assert.equal(select.disabled,false);button.click();await wait();
 const writes=calls.filter(c=>c.operation==='member.redeem');assert.equal(writes.length,2);assert.equal(writes[0].bookingId,'B');assert.equal(writes[0].requestId,writes[1].requestId);assert.deepEqual(writes[0].ticketIds,['POINT']);
 }finally{dom.window.close();}});

for(const owned of [true,false])test('real event page loads '+(owned?'owned usage choices':'unclaimed offers without a booking'),async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../../event/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://qa.local/event/'}),w=dom.window,calls=[];
 try{
  await new Promise(r=>setTimeout(r,0));w.eval(source);w.confirm=()=>true;w.MembershipProgress={render(){}};
  w.MemberSystem={bindDialogKeyboard(){},loadConfig:async()=>({supabaseUrl:'https://fixture.supabase.co'}),signIn:async()=> 'fixture',subscribeRealtime(){},request:async(_c,_surface,_token,action,payload)=>{
   if(action==='user.event.bootstrap')return {profile:{displayName:'QA',tierKey:'general'},usedTickets:[],usedTicketCount:0,offers:[{ticket:{eventTicketId:'EVENT',title:'QA event',ticketType:'coupon',description:'QA',usageMethod:'QA',usageInstructions:'QA'},claim:owned?{claimId:'CLAIM',status:'available',ticketDescription:'QA'}:null,eligibleBookings:owned?[booking('A'),booking('B')]:[],canUse:owned,canClaim:!owned,tierEligible:true,availability:'active'}]};
   calls.push({action,payload});throw Object.assign(new Error('QA location retry'),{code:'LOCATION_OUT_OF_RANGE'});
  }};
  w.eval(fs.readFileSync(path.join(__dirname,'../../event-ticket-ui.js'),'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname,'../../event/app.js'),'utf8'));w.dispatchEvent(new w.Event('DOMContentLoaded'));
  const wait=async check=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,1));}throw Error(w.document.getElementById('errorMessage').textContent||'UI did not settle');};
  const doc=w.document;await wait(()=>!!doc.querySelector('[data-event-ticket-id]'));assert.equal(doc.getElementById('errorView').classList.contains('hidden'),true);
  doc.querySelector('[data-event-ticket-id]').click();const choice=doc.querySelector('[data-ticket-booking-choice]'),button=doc.getElementById('ticketModalAction');
  if(owned){assert.equal(button.disabled,true);const select=choice.querySelector('select');select.value='B';select.dispatchEvent(new w.Event('change'));assert.equal(button.disabled,false);
   button.click();await wait(()=>button.textContent==='確認使用這張票券');assert.equal(calls.length,1);assert.equal(calls[0].payload.bookingId,'B');assert.equal(calls[0].payload.claimId,'CLAIM');
  }else{assert.equal(choice.hidden,true);assert.equal(button.disabled,false);assert.match(button.textContent,/領取/);assert.equal(calls.length,0);}
 }finally{dom.window.close();}
});
