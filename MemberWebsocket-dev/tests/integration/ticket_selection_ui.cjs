const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../ticket-booking-selections.js'),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,15));
const booking={bookingId:'11111111-1111-4111-8111-111111111111',bookingDate:'2026-10-12',startTime:'23:30',endTime:'00:30',startAt:'2026-10-12T23:30:00',endAt:'2026-10-13T00:30:00',status:'confirmed',updatedAt:'2026-10-12T12:00:00Z',editable:true,selections:[{kind:'points',id:'P1',title:'Coupon',status:'pending'}],serviceSlots:[]};
function page(){const dom=new JSDOM('<main id="pointsView"></main>',{runScripts:'outside-only',url:'https://qa.test/points/'}),w=dom.window,calls=[];let failure=null,refreshes=0;
 const options={pointTicketMaxPerRedemption:2,eventTicketMaxPerDay:1,items:[{kind:'points',selectionId:'P1',title:'Coupon',selectable:true,cardId:'C',pointCost:5,pointBalance:7},{kind:'points',selectionId:'P2',title:'Coupon 2',selectable:true,cardId:'C',pointCost:5,pointBalance:7},{kind:'event',selectionId:'E1',title:'Event',selectable:true}]};
 w.confirm=()=>true;w.MemberSystem={request:async(_c,_s,_t,action,body)=>{calls.push({action,body});if(action.endsWith('detail'))return {booking:structuredClone(booking),options};if(failure){const e=failure;failure=null;throw e;}return {booking:{...booking,updatedAt:'new'},options};}};
 w.eval(source);const config={config:{},surface:'points',idToken:'fixture',refresh:async()=>refreshes++};w.TicketBookingSelections.render([structuredClone(booking)],config);
 return {dom,w,calls,config,setFailure:e=>failure=e,refreshes:()=>refreshes};}
test('ticket context uses exact dates including overnight and editor starts from canonical checked selections',async()=>{const p=page();try{assert.match(p.w.TicketBookingSelections.label(booking),/2026-10-12 23:30–翌日 00:30/);p.w.document.querySelector('#bookingSelectionList button').click();await tick();const check=p.w.document.querySelector('[data-ref="P1"]');assert.equal(check.checked,true);assert.equal(p.w.document.getElementById('bookingSelectionSave').disabled,false);assert.equal(p.calls[0].body.bookingId,booking.bookingId);}finally{p.dom.window.close();}});
test('combined point cost blocks submission; removal keeps intent distinct from direct redemption',async()=>{const p=page();try{p.w.document.querySelector('#bookingSelectionList button').click();await tick();const second=p.w.document.querySelector('[data-ref="P2"]');second.checked=true;second.dispatchEvent(new p.w.Event('change'));assert.equal(p.w.document.getElementById('bookingSelectionSave').disabled,true);assert.match(p.w.document.getElementById('bookingSelectionMessage').textContent,/點數不足/);second.checked=false;second.dispatchEvent(new p.w.Event('change'));const first=p.w.document.querySelector('[data-ref="P1"]');first.checked=false;first.dispatchEvent(new p.w.Event('change'));p.w.document.getElementById('bookingSelectionEditor').dispatchEvent(new p.w.Event('submit',{cancelable:true}));await tick();assert.equal(p.calls.at(-1).body.benefits.length,0);assert.match(p.calls.at(-1).action,/booking-selections.update$/);assert.equal(p.refreshes(),1);}finally{p.dom.window.close();}});
test('uncertain response keeps checkbox draft and request ID; changing server version locks stale editor',async()=>{const p=page();try{p.w.document.querySelector('#bookingSelectionList button').click();await tick();const first=p.w.document.querySelector('[data-ref="P1"]');first.checked=false;first.dispatchEvent(new p.w.Event('change'));p.setFailure(new Error('connection lost'));p.w.document.getElementById('bookingSelectionEditor').dispatchEvent(new p.w.Event('submit',{cancelable:true}));await tick();const req=p.calls.at(-1).body.requestId;assert.match(p.w.document.getElementById('bookingSelectionMessage').textContent,/connection lost/);assert.equal(p.w.document.querySelector('[data-ref="P1"]').checked,false);p.w.document.getElementById('bookingSelectionEditor').dispatchEvent(new p.w.Event('submit',{cancelable:true}));await tick();assert.equal(p.calls.at(-1).body.requestId,req);p.w.document.querySelector('#bookingSelectionList button').click();await tick();p.w.TicketBookingSelections.render([{...booking,updatedAt:'changed'}],p.config);assert.equal(p.w.document.getElementById('bookingSelectionSave').disabled,true);assert.match(p.w.document.getElementById('bookingSelectionMessage').textContent,/重新載入/);const check=p.w.document.querySelector('[data-ref=P1]');check.checked=true;check.dispatchEvent(new p.w.Event('change'));assert.equal(p.w.document.getElementById('bookingSelectionSave').disabled,true);}finally{p.dom.window.close();}});



test('production points page omits standalone booking selection panel but preserves per-ticket cancellation',async()=>{
 const app=fs.readFileSync(path.resolve(__dirname,'../../points/app.js'),'utf8');
 assert.match(app,/showStandaloneEditor:\s*false/,'points must disable the standalone editor at the production call site');
 const p=page();
 try{
  const config={...p.config,showStandaloneEditor:false};
  p.w.TicketBookingSelections.render([structuredClone(booking)],config);
  assert.equal(p.w.document.getElementById('bookingSelectionPanel'),null,'even an existing panel is removed');
  p.w.TicketBookingSelections.render([structuredClone(booking)],config);
  assert.equal(p.w.document.getElementById('bookingSelectionPanel'),null,'refresh must not recreate the panel');
  p.w.crypto.randomUUID=()=> 'test-cancel-unique-id';
  assert.equal(await p.w.TicketBookingSelections.cancelPointTicket(booking.bookingId,'P1'),true);
  assert.equal(p.calls.some(call=>call.action==='user.pointcard.booking-selections.detail'),true);
  const update=p.calls.find(call=>call.action==='user.pointcard.booking-selections.update');
  assert.ok(update,'per-ticket cancellation must remain available');
  assert.deepEqual(Array.from(update.body.benefits),[],'only the selected ticket is removed');
  assert.equal(p.refreshes(),1,'cancellation still refreshes the ticket overview');
  assert.equal(p.w.document.getElementById('bookingSelectionPanel'),null);
 } finally {p.dom.window.close();}
});

const ticketOverviewSource=fs.readFileSync(path.resolve(__dirname,'../../points/pointcard-ticket-overview.js'),'utf8');

async function combinedTicketPage({booking=true,snapshot=true,editable=true,confirm=true}={}){
 const dom=new JSDOM('<div id="ticketSummary"></div><div id="ticketList"></div>',{runScripts:'outside-only',url:'https://qa.test/points/'});
 const w=dom.window,requests=[],bookings=[];
 let hasBooking=booking,hasSnapshot=snapshot;
 const ticketId='PT-a8d8a34d273b4fef905e9a0000000001';
 const bookingId='11111111-1111-4111-8111-111111111111';
 const receiptId='BR-a8d8a34d273b4fef905e9a0000000002';
 const pointTicket=()=>{
  const summary={cardId:'card-1',title:'測試集點卡',status:'active',stamps:20,availableStamps:20,
   rewards:[{thresholdStamps:10,ticketTemplateId:'tpl-1',rewardTitle:'測試票券'}]};
  return {cards:[summary],cardDetails:{'card-1':{card:summary,tickets:[{
   ticketId,ticketTemplateId:'tpl-1',status:'available',thresholdStamps:10,ticketTitle:'測試票券',
   reservedForBooking:hasBooking,
   pendingSnapshot:hasSnapshot?{receiptId,updatedAt:'2026-10-13T10:00:00Z'}:null,
   bookingSelections:hasBooking?[{bookingId,status:'pending',editable,bookingDate:'2026-10-13',startTime:'12:00'}]:[],
   eligibleBookings:[]
  }]}}};
 };
 w.confirm=()=>confirm;
 w.MemberUI={pointTicketDetails:()=>w.document.createElement('p')};
 w.fetch=async()=>({ok:true,json:async()=>({ok:true,data:{maxTicketsPerRedemption:2}})});
 w.eval(source);
 const createTicketReservationDisclosure=w.TicketBookingSelections.createTicketReservationDisclosure;
 w.TicketBookingSelections={
  createTicketReservationDisclosure,
  label:()=> '一般預約狀態',
  cancelPointTicket:async(id,ticket)=>{bookings.push({id,ticket});hasBooking=false;w.PointCardTicketOverview.renderSnapshot(pointTicket());return true;}
 };
 w.MemberSystem={request:async(_config,surface,_token,action,body)=>{
  requests.push({surface,action,body});
  if(action!=='user.pointcard.snapshot-ticket.cancel')throw Error('unexpected cancellation operation');
  hasSnapshot=false;return {cancelled:true};
 }};
 w.eval(ticketOverviewSource);
 await w.PointCardTicketOverview.initialize({config:{supabaseUrl:'https://example.supabase.co',supabasePublishableKey:'test'},
   idToken:'member-fixture',refreshData:async()=>w.PointCardTicketOverview.renderSnapshot(pointTicket())});
 w.PointCardTicketOverview.renderSnapshot(pointTicket());
 const buttons=()=>[...w.document.querySelectorAll('.member-ticket .ticket-reservation-cancel')];
 const labels=()=>buttons().map(button=>button.textContent);
 return {dom,w,requests,bookings,buttons,labels,ticketId,bookingId,receiptId};
}

test('point ticket offers two independent cancellation buttons when both reservation and snapshot are pending',async()=>{
 const p=await combinedTicketPage();
 try{
  assert.deepEqual(p.labels(),['取消此一般預約票券','取消此快照票券']);
  const card=p.w.document.querySelector('.member-ticket');
  assert.match(card.textContent,/已預約使用・快照待審核/);
  assert.match(card.textContent,/預約與快照待審核/);
  assert.equal(card.querySelector('.ticket-overview-check').checked,true);
  assert.equal(card.querySelector('.ticket-overview-check').disabled,true);
  assert.equal(p.buttons().every(b=>!b.disabled),true);
 }finally{p.dom.window.close();}
});

test('cancelling a booking reservation preserves snapshot action and does not call snapshot API',async()=>{
 const p=await combinedTicketPage();
 try{
  p.buttons()[0].click();
  await tick();
  assert.deepEqual(p.bookings,[{id:p.bookingId,ticket:p.ticketId}]);
  assert.equal(p.requests.length,0);
  assert.deepEqual(p.labels(),['取消此快照票券']);
  assert.match(p.w.document.querySelector('.member-ticket').textContent,/快照待審核/);
 }finally{p.dom.window.close();}
});

test('cancelling a snapshot preserves the booking reservation and sends the correct receipt version',async()=>{
 const p=await combinedTicketPage();
 try{
  p.buttons()[1].click();
  await tick();
  assert.equal(p.bookings.length,0);
  assert.deepEqual(JSON.parse(JSON.stringify(p.requests)),[{surface:'points',action:'user.pointcard.snapshot-ticket.cancel',body:{
   receiptId:p.receiptId,ticketId:p.ticketId,expectedUpdatedAt:'2026-10-13T10:00:00Z'
  }}]);
  assert.deepEqual(p.labels(),['取消此一般預約票券']);
  assert.match(p.w.document.querySelector('.member-ticket').textContent,/已預約使用/);
 }finally{p.dom.window.close();}
});

test('each ticket source can be cancelled independently even when booking cannot be edited',async()=>{
 const onlyBooking=await combinedTicketPage({snapshot:false});
 const onlySnapshot=await combinedTicketPage({booking:false});
 const lockedBooking=await combinedTicketPage({editable:false});
 const declined=await combinedTicketPage({confirm:false});
 try{
  assert.deepEqual(onlyBooking.labels(),['取消此一般預約票券']);
  assert.deepEqual(onlySnapshot.labels(),['取消此快照票券']);
  assert.deepEqual(lockedBooking.labels(),['取消此快照票券']);
  declined.buttons()[1].click();
  await tick();
  assert.deepEqual(declined.labels(),['取消此一般預約票券','取消此快照票券']);
  assert.equal(declined.requests.length,0);
 }finally{
  onlyBooking.dom.window.close();onlySnapshot.dom.window.close();
  lockedBooking.dom.window.close();declined.dom.window.close();
 }
});
