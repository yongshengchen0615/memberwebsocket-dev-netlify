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

test('AC-004: scheduled fixed issuance observes stored calendar dependencies and preserves all other tenant jobs',async()=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
 try{await require('./fixtures/feature-dependencies.cjs')(db);}finally{await db.close();}
});
