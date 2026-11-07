const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
// Member grants must hide the whole surface/related UI and remove stale intent,
// even when a delayed catalog still contains previously authorized tickets.
async function memberGrantFixture(features){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'booking/index.html'),'utf8'),{url:'https://fixture.test/booking/?business=merchant-a',runScripts:'outside-only'});
 const w=dom.window,calls=[],observers=[],Observer=w.MutationObserver;let current=features,reply;
 w.MutationObserver=class extends Observer{constructor(callback){super(callback);observers.push(this);}};
 w.fetch=async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body);if(reply)return reply(body);return {ok:true,json:async()=>({ok:true,data:{business:'merchant-a',name:'A',features:current,line:{}}})};};
 w.eval(fs.readFileSync(path.join(root,'business-context.js'),'utf8'));
 const config={supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'fixture'};
 await w.BusinessContext.configure(config);
 return {w,d:w.document,config,calls,dom,reply:fn=>{reply=fn;},change:async next=>{current=next;await w.BusinessContext.refresh(config);await tick();},close:()=>{observers.forEach(o=>o.disconnect());w.close();}};
}
test('AC-MEMBER-001/002: disabled member features hide complete normal and snapshot UI, including late dialogs',async()=>{
 const h=await memberGrantFixture({booking:true});try{
  for(const id of ['bookingBenefits','membershipProgress','bookingAccessibleTickets','bookingAccessibleTicketsStatus']){
   assert.equal(h.w.getComputedStyle(h.d.getElementById(id)).display,'none',id);
  }
  h.d.body.insertAdjacentHTML('beforeend','<fieldset id="snapshotTicketFields"><input type="checkbox" checked data-snapshot-id="OLD" data-snapshot-kind="points"></fieldset><div class="booking-confirm-benefits">本次未使用票券</div>');await tick();
  assert.equal(h.w.getComputedStyle(h.d.getElementById('snapshotTicketFields')).display,'none');
  assert.equal(h.d.getElementById('snapshotTicketFields').inert,true);
  assert.equal(h.w.getComputedStyle(h.d.querySelector('.booking-confirm-benefits')).display,'none');
  await h.change({booking:true,events:true});
  assert.equal(h.d.getElementById('snapshotTicketFields').inert,false);
  assert.notEqual(h.w.getComputedStyle(h.d.getElementById('bookingBenefits')).display,'none');
  assert.equal(h.w.getComputedStyle(h.d.getElementById('membershipProgress')).display,'none');
 }finally{h.close();}
});
test('AC-MEMBER-003: revocation removes selected benefits and delayed catalogs cannot restore them; regrant recovers',async()=>{
 const h=await memberGrantFixture({booking:true,points:true,events:true,calendar:true});try{
  const items=[{kind:'points',id:'R',selectionId:'P',selectable:true,cardId:'C',pointCost:1,pointBalance:10,title:'point'}, {kind:'event',id:'E',selectionId:'E',selectable:true,title:'event'}];
  let complete;
  h.w.BookingSystem={bookingBenefits:async()=>({items})};
  h.w.eval(fs.readFileSync(path.join(root,'ui-components.js'),'utf8'));
  h.w.eval(fs.readFileSync(path.join(root,'booking/booking-benefits.js'),'utf8'));
  h.w.BookingBenefits.start(h.config,'synthetic');await tick();
  h.w.BookingBenefits.setSelection([{kind:'points',id:'P'},{kind:'event',id:'E'}]);
  assert.equal(h.w.BookingBenefits.selectionPayload().length,2);
  h.w.BookingSystem.bookingBenefits=()=>new Promise(r=>{complete=r;});h.w.BookingBenefits.syncNow();
  await h.change({booking:true,events:true});
  assert.equal(JSON.stringify(h.w.BookingBenefits.selectionPayload()),'[{"kind":"event","id":"E"}]');
  complete({items});await tick();
  assert.deepEqual(Array.from(h.d.querySelectorAll('.booking-benefit-group'),n=>n.dataset.benefitKind),['event']);
  h.w.BookingBenefits.clearSelection();
  assert.doesNotMatch(h.d.getElementById('bookingBenefitsStatus').textContent,/集點卡|點數/);
  h.w.BookingSystem.bookingBenefits=async()=>({items});
  await h.change({booking:true,points:true,events:true});await tick();
  assert.deepEqual(Array.from(h.d.querySelectorAll('.booking-benefit-group'),n=>n.dataset.benefitKind),['points','event']);
  await h.change({booking:true});
  assert.equal(h.w.BookingBenefits.selectionPayload().length,0);
  assert.equal(h.w.BookingBenefits.getItems().length,0);
 }finally{h.close();}
});
test('AC-MEMBER-003/004: strict booleans and own-feature revocation fail closed while preserving drafts',async()=>{
 const h=await memberGrantFixture({booking:true,points:'true',events:1});try{
  assert.equal(h.w.BusinessContext.allows('points'),false);assert.equal(h.w.BusinessContext.allows('events'),false);
  const draft=h.d.getElementById('memberNote');draft.value='preserve';
  await h.change({events:true});
  assert.equal(h.d.getElementById('bookingView').inert,true);
  assert.equal(draft.value,'preserve');
  assert.equal(h.calls[1].feature,undefined,'refresh reads grants even after this surface is revoked');
  await h.change({booking:true});assert.equal(h.d.getElementById('bookingView').inert,false);
 }finally{h.close();}
});
test('AC-MEMBER-004: failed or other-shop responses never replace known grants or LINE identity configuration',async()=>{
 const h=await memberGrantFixture({booking:true});try{
  h.config.bookingLiffId='verified-module-liff';
  h.reply(async()=>{throw Error('offline');});
  await assert.rejects(h.w.BusinessContext.refresh(h.config),/offline/);
  assert.equal(h.w.BusinessContext.allows('points'),false);
  h.reply(async()=>({ok:true,json:async()=>({ok:true,data:{business:'merchant-b',features:{points:true},line:{}}})}));
  await assert.rejects(h.w.BusinessContext.refresh(h.config),/商家設定不一致/);
  assert.equal(h.w.BusinessContext.allows('points'),false);assert.equal(h.config.business,'merchant-a');
  h.reply(async()=>({ok:true,json:async()=>({ok:true,data:{business:'merchant-a',features:{booking:true,points:true},line:{bookingLiffId:'different-default'}}})}));
  await h.w.BusinessContext.refresh(h.config);
  assert.equal(h.config.bookingLiffId,'verified-module-liff');assert.equal(h.w.BusinessContext.allows('points'),true);
 }finally{h.close();}
});
test('AC-MEMBER-003: delayed configure keeps tenant scope and cannot roll newer grants back',async()=>{
 const h=await memberGrantFixture({booking:true,points:true});try{
  let finish;const delayed=new Promise(r=>{finish=r;});
  h.reply(body=>body.feature?delayed:Promise.resolve({ok:true,json:async()=>({ok:true,data:{business:'merchant-a',features:{booking:true},line:{}}})}));
  const second={...h.config};delete second.business;
  const old=h.w.BusinessContext.configure(second);await h.w.BusinessContext.refresh(h.config);
  finish({ok:true,json:async()=>({ok:true,data:{business:'merchant-a',features:{booking:true,points:true},line:{}}})});await old;
  assert.equal(second.business,'merchant-a');assert.equal(second.grantedFeatures.points,false);
  assert.equal(h.w.BusinessContext.allows('points'),false);
 }finally{h.close();}
});
test('AC-MEMBER-003: open snapshot keeps photo/event draft but revoked or forged point selections never enter prepare',async()=>{
 const h=await memberGrantFixture({booking:true,points:true,events:true});try{
  const w=h.w,calls=[];
  const items=[{kind:'points',id:'R',selectionId:'P',selectable:true,title:'point',cardId:'C',pointCost:1,pointBalance:10},{kind:'event',id:'E',selectionId:'E',selectable:true,title:'event'}];
  w.TestModeClient={getSessionToken:()=> 'synthetic'};
  w.BookingSystem={getSession:()=>({config:h.config,idToken:'synthetic'}),request:async(_c,_t,_token,action,payload)=>{
   calls.push({action,payload});
   if(action.endsWith('.prepare'))return {receiptId:'synthetic-receipt',objectPath:'synthetic',uploadToken:'synthetic'};
   if(action.endsWith('.finalize'))return {receiptId:'synthetic-receipt',status:'awaiting_review'};
   return {items,snapshotLocationRequired:false,snapshotLocations:[],bookings:[],submissions:[]};
  }};
  w.supabase={createClient:()=>({storage:{from:()=>({uploadToSignedUrl:async()=>({})})}})};
  w.eval(fs.readFileSync(path.join(root,'booking/booking-receipt.js'),'utf8'));
  await w.BookingReceipts.openAccessibleE2ESnapshot(new w.Blob(['synthetic-photo'],{type:'image/webp'}));await tick();
  await h.change({booking:true,points:true,events:true,calendar:true});await tick();
  h.d.querySelector('[data-snapshot-kind="points"]').click();h.d.querySelector('[data-snapshot-kind="event"]').click();
  await h.change({booking:true,events:true});await tick();
  assert.equal(h.d.querySelector('[data-snapshot-kind="points"]'),null);
  assert.equal(h.d.querySelector('[data-snapshot-kind="event"]').checked,true);
  assert.doesNotMatch(h.d.getElementById('snapshotTicketSelectionSummary').textContent,/集點卡|扣點/);
  h.d.getElementById('snapshotTicketChoices').insertAdjacentHTML('beforeend','<input type="checkbox" checked data-snapshot-kind="points" data-snapshot-id="forged">');
  h.d.getElementById('bookingReceiptSubmit').click();
  for(let n=0;n<20&&!calls.some(c=>c.action.endsWith('.prepare'));n++)await tick();
  const prepared=calls.find(c=>c.action.endsWith('.prepare'));
  assert.ok(prepared,'the existing photo remains submittable after grant revocation');
  assert.equal(JSON.stringify(prepared.payload.benefits),'[{"kind":"event","id":"E"}]');
 }finally{h.w.dispatchEvent(new h.w.Event('pagehide'));h.close();}
});
function fixture(){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'admin/index.html'),'utf8'),{url:'https://fixture.test/admin/?business=merchant-a',runScripts:'outside-only'});
 const observers=[],Observer=dom.window.MutationObserver;
 dom.window.MutationObserver=class extends Observer{constructor(callback){super(callback);observers.push(this);}};
 dom.window.eval(fs.readFileSync(path.join(root,'admin/business-workspace.js'),'utf8'));
 const apply=features=>dom.window.BusinessWorkspace.apply({features,business:{name:'A',slug:'merchant-a'}});
 return {dom,w:dom.window,d:dom.window.document,apply,close:()=>{observers.forEach(observer=>observer.disconnect());dom.window.close();}};
}
test('AC-001/004: nested points controls and service mode track grants without disabling service-time grants',async()=>{
 const h=fixture();try{
  h.apply({membership:true});
  assert.equal(h.d.getElementById('activeCardCount').closest('div').dataset.businessAllowed,'false');
  assert.equal(h.d.getElementById('todayEntryCount').closest('div').dataset.businessAllowed,'false');
  assert.equal(h.d.getElementById('grantStampsEnabled').closest('fieldset').dataset.businessAllowed,'false');
  assert.equal(h.d.querySelector('#grantMode option[value="services"]').disabled,true);
  assert.notEqual(h.d.getElementById('grantServiceTimeEnabled').closest('fieldset').dataset.businessAllowed,'false');
  h.apply({membership:true,points:true,booking:true});
  assert.equal(h.d.getElementById('grantStampsEnabled').closest('fieldset').dataset.businessAllowed,'true');
  assert.equal(h.d.querySelector('#grantMode option[value="services"]').disabled,false);
  h.d.getElementById('grantMode').value='services';
  const late=h.d.createElement('section');late.id='calendarBonusPointsControls';h.d.getElementById('adminView').append(late);await tick();
  h.apply({membership:true,calendar:true});
  assert.equal(h.d.getElementById('grantMode').value,'manual');
  assert.equal(h.d.getElementById('grantServiceFields').dataset.businessAllowed,'false');
  assert.equal(late.dataset.businessAllowed,'false');
  h.apply({membership:true,calendar:true,points:true});
  assert.equal(late.dataset.businessAllowed,'true');
 }finally{h.close();}
});
test('AC-003: late booking rewards and ticket booking restrictions are hidden when dependencies are missing',async()=>{
 const h=fixture();try{
  h.apply({booking:true,events:true});
  const form=h.d.createElement('form');form.innerHTML='<label><input data-type-reward-enabled type="checkbox">自動集點</label><div data-type-reward-fields></div>';
  h.d.body.append(form);await tick();
  assert.equal(form.querySelector('label').dataset.businessAllowed,'false');
  assert.equal(form.querySelector('[data-type-reward-fields]').dataset.businessAllowed,'false');
  h.apply({events:true});
  assert.equal(h.d.getElementById('eventTicketRequiredServiceIds').closest('fieldset').dataset.businessAllowed,'false');
  h.apply({events:true,booking:true,points:true});
  assert.equal(form.querySelector('label').dataset.businessAllowed,'true');
 }finally{h.close();}
});
test('AC-SYNC-004: revoke/re-enable covers summaries, dynamically rendered rules, records and parent dialogs',async()=>{
 const h=fixture();try{
  h.d.body.insertAdjacentHTML('beforeend','<div class="fixed-ticket-inline-actions"><input id="fixedTicketCalendarEnabled"></div><p id="fixedTicketCalendarSummary">saved calendar integration</p><section data-business-requires="booking points"><input data-synthetic-draft value="keep draft"></section><article data-business-requires="membership calendar"></article><div id="bookingAdminCrudModal" class="modal hidden"><button class="close-button">close</button></div>');
  const all={membership:true,points:true,events:true,calendar:true,booking:true};h.apply(all);
  const map=[['membership','#memberCount','div'],['membership','#activeMemberCount','div'],['calendar','#fixedTicketCalendarSummary'],['points','[data-synthetic-draft]','section'],['calendar','article[data-business-requires]'],['membership','#memberModal'],['membership','#memberRecordsModal'],['membership','#grantModal'],['booking','#bookingAdminCrudModal']];
  for(const [feature,selector,parent]of map){
   h.apply({...all,[feature]:false});const match=h.d.querySelector(selector),node=parent?match.closest(parent):match;
   assert.equal(node.dataset.businessAllowed,'false',selector);assert.equal(node.inert,true,selector);
   h.apply(all);assert.equal(node.dataset.businessAllowed,'true',selector);
  }
  assert.equal(h.d.querySelector('[data-synthetic-draft]').value,'keep draft');
  const modal=h.d.getElementById('bookingAdminCrudModal');let closed=0;
  modal.querySelector('button').addEventListener('click',()=>{closed++;modal.classList.add('hidden');});modal.classList.remove('hidden');
  h.apply({...all,booking:false});assert.equal(closed,1,'revoking the owner closes its active modal before making it inert');
 }finally{h.close();}
});
test('AC-SYNC-005: revoking the current main tab immediately selects an allowed workspace',()=>{
 const h=fixture();try{
  h.apply({membership:true,points:true});
  for(const tab of h.d.querySelectorAll('.surface-nav [role="tab"]'))tab.setAttribute('aria-selected',String(tab.id==='cardsTab'));
  h.apply({membership:true,points:false});
  assert.equal(h.d.getElementById('membersTab').getAttribute('aria-selected'),'true');
  assert.equal(h.d.getElementById('cardsTab').getAttribute('aria-selected'),'false');
  assert.equal(h.d.getElementById('membersPanel').hidden,false);
 }finally{h.close();}
});
test('review: booking ticket edit action is hidden with no ticket grant and restored for either grant',async()=>{
 const h=fixture();try{
  h.apply({booking:true});
  const button=h.d.createElement('button');button.dataset.bookingBenefitsAction='true';h.d.body.append(button);await tick();
  assert.equal(button.dataset.businessAllowed,'false');
  h.apply({booking:true,events:true});assert.equal(button.dataset.businessAllowed,'true');
  h.apply({booking:true,points:true});assert.equal(button.dataset.businessAllowed,'true');
  h.apply({booking:true});assert.equal(button.dataset.businessAllowed,'false');
 }finally{h.close();}
});
test('AC-003: bootstrap and standalone event saves do not call unavailable calendar extensions',async()=>{
 const h=fixture(),calls=[];let external=0;try{
  h.w.MemberSystem={request:async(config,client,id,action)=>{calls.push(action);return action==='admin.bootstrap'?{features:{membership:true,events:true},calendarItems:[]}:{eventTicket:{eventTicketId:'E'}};}};
  h.w.fetch=async()=>{external++;throw Error('unexpected optional calendar request');};
  h.w.eval(fs.readFileSync(path.join(root,'admin/grant-automation.js'),'utf8'));
  const config={business:'merchant-a'};
  await h.w.MemberSystem.request(config,'admin','fixture','admin.bootstrap',{});
  await h.w.MemberSystem.request(config,'admin','fixture','admin.event-tickets.save',{eventTicket:{title:'Standalone'}});
  assert.deepEqual(calls,['admin.bootstrap','admin.event-tickets.save']);
  assert.equal(external,0);
 }finally{h.close();}
});
test('review: hidden fixed-calendar choice is omitted so unrelated event edits retain stored configuration',async()=>{
 const h=fixture();let saved;try{
  h.apply({events:true});
  h.d.body.insertAdjacentHTML('beforeend','<section id="fixedTicketScheduleFields"><input id="fixedTicketCalendarEnabled" type="checkbox" checked></section>');
  h.w.fetch=async(_url,init)=>{saved=JSON.parse(init.body);return new Response('{"ok":true,"data":{}}');};
  h.w.eval(fs.readFileSync(path.join(root,'admin/fixed-ticket-calendar-option.js'),'utf8'));
  await h.w.fetch('https://fixture.supabase.co/functions/v1/fixed-ticket-automation',{body:JSON.stringify({action:'admin.fixed-tickets.save',template:{fixedTicketId:'FT-1',title:'Changed'}})});
  assert.equal(Object.hasOwn(saved.template,'calendarEnabled'),false);
 }finally{h.close();}
});

test('AC-004: scheduled fixed issuance observes stored calendar dependencies and preserves all other tenant jobs',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
 try{await require('./fixtures/feature-dependencies.cjs')(db);}finally{await db.close();}
});

async function receiptFixture(holdWrite=false){
 const dom=new JSDOM('<div id="adminView"><nav class="surface-nav"></nav></div><div id="bookingAdminQueuePanel" data-queue-mode="accessible"></div>',{url:'https://fixture.test/admin/?business=synthetic',runScripts:'outside-only'});
 const w=dom.window,observers=[],Observer=w.MutationObserver;
 w.MutationObserver=class extends Observer{constructor(fn){super(fn);observers.push(this);}};
 let features={membership:true,points:true,events:true,calendar:true,booking:true},submitted,finish;
 const options={services:[{id:'svc1',title:'Service',service_type:'Massage',duration_minutes:60}],rewardRules:[],currentBenefits:[{kind:'event',id:'ev1',status:'pending',title:'Event Ticket'}],benefitCatalog:{items:[{kind:'event',selectionId:'ev1',title:'Event Ticket',selectable:true}],eventTicketMaxPerDay:0,pointTicketMaxPerRedemption:0},primaryTechnicianConfigured:true};
 w.MemberSystem={getSession:()=>({config:{business:'synthetic'},idToken:'fixture'}),request:async(_c,_t,_i,action,body)=>{
  if(action==='admin.booking.receipt.url')return{signedUrl:'https://fixture.test/receipt.png'};
  if(action==='admin.booking.receipt.options')return options;
  if(action==='admin.booking.receipt.register'){submitted=body;if(holdWrite)return new Promise((_resolve,reject)=>{finish=()=>reject(Error('delayed failure'));});return{settlement:{}};}
  return{};
 }};
 w.eval(fs.readFileSync(path.join(root,'admin/business-workspace.js'),'utf8'));w.eval(fs.readFileSync(path.join(root,'admin/booking-accessible-admin.js'),'utf8'));
 const apply=patch=>{features={...features,...patch};w.BusinessWorkspace.apply({features});};apply({});
 w.dispatchEvent(new w.CustomEvent('admin:accessible-receipts-updated',{detail:{submissions:[{receiptId:'r1',createdAt:'2026-11-06T00:00:00Z',memberName:'Synthetic'}]}}));
 w.document.querySelector('.accessible-admin-review-button').click();await tick();await tick();
 return{w,apply,payload:()=>submitted,finish:()=>finish?.(),submit(){w.document.querySelector('[data-service-check]').checked=true;w.document.getElementById('accessibleAdminForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));},close(){observers.forEach(o=>o.disconnect());w.close();}};
}
test('AC-SYNC-006: revoked checked receipt benefits remain drafts but never enter a new write',async()=>{
 const h=await receiptFixture();try{
  h.apply({events:false});await tick();const check=h.w.document.querySelector('[data-benefit-check]');
  assert.equal(check.checked,true);assert.equal(check.closest('[data-business-requires]').dataset.businessAllowed,'false');
  h.submit();await tick();assert.deepEqual(JSON.parse(JSON.stringify(h.payload().benefits)),[]);
 }finally{h.close();}
});
test('AC-SYNC-007: revoking a busy receipt owner cleans up private image and cannot reopen on regrant',async()=>{
 const h=await receiptFixture(true);try{
  h.submit();await tick();assert.equal(h.w.document.getElementById('accessibleAdminClose').disabled,true);
  h.apply({booking:false});await tick();const modal=h.w.document.getElementById('accessibleAdminModal');
  assert.equal(modal.classList.contains('hidden'),true);assert.equal(modal.dataset.receiptId,undefined);assert.equal(h.w.document.getElementById('accessibleAdminImage').getAttribute('src'),null);
  h.apply({booking:true});await tick();assert.equal(modal.classList.contains('hidden'),true);
  h.finish();await tick();
 }finally{h.close();}
});
