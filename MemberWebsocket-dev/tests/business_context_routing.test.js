const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){
 const calls=[],listeners={},location=new URL('https://app.test/admin/workspace.html?business=merchant-a');
 const links=[{href:'https://app.test/admin/',dataset:{businessSwitch:'true'}},{href:'https://app.test/member/',dataset:{}},{href:'https://app.test/admin/workspace.html?business=merchant-b',dataset:{}}];
 const window={location,fetch:async(input,init)=>{calls.push({input,body:init?.body&&JSON.parse(init.body)});return new Response('{}');}};
 const context={window,location,URL,URLSearchParams,document:{documentElement:{},querySelectorAll:()=>links,addEventListener:(name,callback)=>listeners[name]=callback},MutationObserver:class{observe(){}},Response};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../business-context.js'),'utf8'),context);
 return{window,calls,links,listeners};
}
test('merchant account operations keep fixed Channel routing while selected settings retain business scope',async()=>{
 const h=fixture();
 for(const action of ['platform.qualification.bootstrap','platform.qualification.submit','platform.qualification.list','platform.qualification.review','platform.merchant.list','platform.merchant.submit','platform.merchant.get','platform.merchant.review']){
  await h.window.fetch('https://fixture.supabase.co/functions/v1/platform-api',{method:'POST',body:JSON.stringify({action,idToken:'synthetic'})});
  assert.equal(h.calls.at(-1).body.business,undefined,action);
 }
 await h.window.fetch('https://fixture.supabase.co/functions/v1/platform-api',{method:'POST',body:JSON.stringify({action:'platform.line.save'})});
 assert.equal(h.calls.at(-1).body.business,'merchant-a');
 await h.window.fetch('https://fixture.supabase.co/functions/v1/api',{method:'POST',body:JSON.stringify({action:'admin.bootstrap'})});
 assert.equal(h.calls.at(-1).body.business,'merchant-a');
});
test('return-to-my-merchants link drops selected business; ordinary module navigation retains current business',()=>{
 const h=fixture();h.listeners.DOMContentLoaded();
 assert.equal(h.links[0].href,'https://app.test/admin/');
 assert.equal(h.links[1].href,'https://app.test/member/?business=merchant-a');
 assert.equal(h.links[2].href,'https://app.test/admin/workspace.html?business=merchant-b');
});

function publicFixture(surface,line){
 const location=new URL('https://app.test/'+surface+'/?business=merchant-a');
 const document={documentElement:{},querySelectorAll:()=>[],addEventListener(){}};
 const window={location,setTimeout,clearTimeout,fetch:async()=>Response.json({ok:true,data:{business:'merchant-a',name:'Merchant',features:{membership:true,points:true,events:true,calendar:true,booking:true},line}})};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../business-context.js'),'utf8'),{window,location,document,URL,URLSearchParams,Response,AbortController});
 return window.BusinessContext;
}
const featureKeys=['memberLiffId','pointsLiffId','eventLiffId','calendarLiffId','bookingLiffId'];
const globalConfig=()=>({supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic',adminLiffId:'2010791619-Account',platformLiffId:'2012065297-Root',...Object.fromEntries(featureKeys.map(key=>[key,'2010787602-Global'+key]))});
test('AC-002: every merchant surface uses saved feature IDs and clears missing legacy global fallbacks',async()=>{
 for(const [surface,key]of Object.entries({member:'memberLiffId',points:'pointsLiffId',event:'eventLiffId',calendar:'calendarLiffId',booking:'bookingLiffId'})){
  const config=globalConfig(),context=publicFixture(surface,{memberChannelId:'2010787602',[key]:'2010787602-Merchant'});
  await context.configure(config);
  assert.equal(config[key],'2010787602-Merchant');
  for(const missing of featureKeys.filter(k=>k!==key))assert.equal(config[missing],'',surface+': missing '+missing+' must not keep a global default');
  assert.equal(config.adminLiffId,'2010791619-Account','account admin remains available until merchant admin is configured');
  assert.equal(config.platformLiffId,'2012065297-Root');
 }
});
test('AC-002: missing merchant LINE settings clear all member IDs but preserve management; saved merchant admin overrides account',async()=>{
 for(const line of [{},{memberChannelId:'2010787602'},{adminLiffId:'2099999999-MerchantAdmin'}]){
  const config=globalConfig();await publicFixture('member',line).configure(config);
  for(const key of featureKeys)assert.equal(config[key],'');
  assert.equal(config.adminLiffId,line.adminLiffId||'2010791619-Account');
  assert.equal(config.platformLiffId,'2012065297-Root');
 }
});

test('AC-004: missing feature LIFF fails before SDK initialization and explains merchant setup',async()=>{
 const window={location:new URL('https://app.test/booking/'),setTimeout,clearTimeout};
 const context={window,document:{addEventListener(){},removeEventListener(){}},URL,URLSearchParams,AbortController,Map,Set,Date,console};
 for(const file of ['member-system.js','booking/common.js','booking/liff-fresh-login.js'])vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../'+file),'utf8'),context);
 const config={supabaseUrl:'https://fixture.supabase.co',supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',supabasePublishableKey:'synthetic',adminLiffId:'2010791619-Account',platformLiffId:'2012065297-Root'};
 for(const surface of ['member','points','event','calendar','booking']){
  await assert.rejects(window.MemberSystem.signIn(config,surface),e=>e.code==='CONFIG_ERROR'&&/商家.*LINE.*設定/.test(e.message));
 }
 await assert.rejects(window.BookingSystem.signIn(config,'booking'),e=>e.code==='LIFF_CONFIG_MISSING'&&/商家.*LINE.*設定/.test(e.message));
 await assert.rejects(window.BookingSystem.signIn(config,'member'),e=>e.code==='LIFF_CONFIG_MISSING'&&/商家.*LINE.*設定/.test(e.message));
});

function merchantRedirect(url, sessionStorage) {
 const location=new URL(url),calls=[];
 const window={location,sessionStorage,setTimeout,clearTimeout,fetch:async(input,init)=>{
  calls.push({input,body:JSON.parse(init.body)});
  return Response.json({ok:true,data:{business:'merchant-a',name:'Merchant A',features:{events:true},line:{eventLiffId:'2010787602-MerchantEvent'}}});
 }};
 const document={documentElement:{},querySelectorAll:()=>[],addEventListener(){}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../business-context.js'),'utf8'),{window,location,document,URL,URLSearchParams,Response,AbortController});
 return {context:window.BusinessContext,calls};
}
function merchantTabStorage(){
 const values=new Map();
 return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value))};
}
test('AC-005: Event LIFF OAuth callback restores only its previously selected business before reading merchant LIFF ID',async()=>{
 const storage=merchantTabStorage(),initial=merchantRedirect('https://app.test/event/?source=event-ticket-calendar&eventTicketId=EVT-test&business=merchant-a',storage);
 assert.equal(initial.context.slug,'merchant-a');
 const callback=merchantRedirect('https://app.test/event/?code=synthetic-code&state=synthetic-state',storage);
 assert.equal(callback.context.slug,'merchant-a');
 const config=globalConfig();await callback.context.configure(config);
 assert.equal(config.eventLiffId,'2010787602-MerchantEvent');
 assert.equal(callback.calls[0].body.action,'platform.business.public');
 assert.equal(callback.calls[0].body.feature,'events');
 assert.equal(callback.calls[0].body.business,'merchant-a');
 assert.equal(merchantRedirect('https://app.test/event/',storage).context.slug,'','normal unscoped visits must not inherit merchant identity');
 assert.equal(merchantRedirect('https://app.test/points/?code=a&state=b',storage).context.slug,'','other surfaces cannot inherit event scope');
});
test('AC-006: restored Event LIFF merchant context is bounded and explicit URL scope overrides stale tab state',()=>{
 const storage=merchantTabStorage();
 storage.setItem('merchant-liff-scope:event',JSON.stringify({business:'merchant-a',surface:'event',savedAt:Date.now()-11*60*1000}));
 assert.equal(merchantRedirect('https://app.test/event/?code=c&state=s',storage).context.slug,'','expired context must not be used');
 storage.setItem('merchant-liff-scope:event',JSON.stringify({business:'merchant-a',surface:'event',savedAt:Date.now()}));
 assert.equal(merchantRedirect('https://app.test/event/?business=merchant-b&code=c&state=s',storage).context.slug,'merchant-b','explicit business always wins');
 assert.equal(merchantRedirect('https://app.test/event/?liff.state='+encodeURIComponent('/event/?business=merchant-a'),storage).context.slug,'merchant-a','LINE primary redirect state wins');
});
