const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
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
