const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');

const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'member-system.js'),'utf8');
const surfaces=['member','points','event','calendar'];
function harness(route,{reloadThrows=false}={}){
  const listeners=new Map(),calls=[],document={body:{hidden:false},visibilityState:'visible'};
  const local=new Map(),session=new Map();
  const window={
    crypto:webcrypto,location:{pathname:route,search:'',href:'https://preview.example.test'+route,
      reload(){calls.push('reload');if(reloadThrows)throw Error('reload blocked');}},
    addEventListener(name,handler){const handlers=listeners.get(name)||[];handlers.push(handler);listeners.set(name,handlers);},
    localStorage:{getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)},
    sessionStorage:{getItem:k=>session.get(k)||null,setItem:(k,v)=>session.set(k,v),removeItem:k=>session.delete(k)},
    setTimeout(){return 1;},clearTimeout(){},
    liff:{
      async init({liffId}){calls.push('init:'+liffId);},
      isInClient(){return true;},isLoggedIn(){return true;},
      getIDToken(){calls.push('token');return 'fixture-line-token';},
      login(){calls.push('login');throw Error('in-LIFF login forbidden');}
    }
  };
  const fetch=async(_url,options)=>{
    const payload=JSON.parse(options.body);
    calls.push(payload.action);
    return {ok:true,status:200,text:async()=>JSON.stringify({ok:true,data:{state:'claimed'}})};
  };
  vm.runInNewContext(source,{window,document,fetch,URL,AbortController,Uint8Array,Blob});
  return {window,document,calls,listeners,runPageShow:persisted=>{
    for(const handler of listeners.get('pageshow')||[])handler({persisted});
  }};
}
function fixtureConfig(){
  return {realtimeEnabled:false,supabaseUrl:'https://fixture.supabase.co',
    supabaseFunctionUrl:'https://fixture.supabase.co/functions/v1/api',
    memberCalendarFunctionUrl:'https://fixture.supabase.co/functions/v1/member-calendar-api',
    supabasePublishableKey:'sb_publishable_fixture',
    memberLiffId:'member-fixture',pointsLiffId:'points-fixture',
    eventLiffId:'event-fixture',calendarLiffId:'calendar-fixture',
    bookingLiffId:'booking-fixture',adminLiffId:'admin-fixture'};
}
for(const surface of surfaces){
  test('AC-123-01 '+surface+': a BFCache restore conceals previous member UI before a fresh LINE entry',()=>{
    const h=harness('/'+surface+'/');
    assert.equal(h.document.body.hidden,false);
    h.runPageShow(true);
    assert.equal(h.document.body.hidden,true,'restored private content must be concealed synchronously');
    assert.deepEqual(h.calls,['reload'],'restored document must run a new LIFF initialization, not reuse old token');
  });
  test('AC-123-02 '+surface+': ordinary page show cannot cause login reload loops',()=>{
    const h=harness('/'+surface+'/');
    h.runPageShow(false);
    assert.equal(h.document.body.hidden,false);
    assert.deepEqual(h.calls,[]);
  });
  test('AC-123-03 '+surface+': in-app initial visit verifies LINE and claims exact surface session on server',async()=>{
    const h=harness('/'+surface+'/');
    const token=await h.window.MemberSystem.signIn(fixtureConfig(),surface);
    assert.equal(token,'fixture-line-token');
    assert.equal(h.window.MemberSystem.getSession(surface).idToken,token);
    assert.equal(h.calls[0],'init:'+fixtureConfig()[surface+'LiffId']);
    assert.ok(h.calls.includes('token'));
    assert.ok(h.calls.includes('user.'+surface+'.session.claim'));
    assert.ok(!h.calls.includes('login'));
  });
}
test('AC-123-04 admin and booking lifecycles remain independently managed',()=>{
  for(const route of ['/admin/','/platform/','/booking/','/','/member-invalid/']){
    const h=harness(route);
    h.runPageShow(true);
    assert.equal(h.document.body.hidden,false,route);
    assert.deepEqual(h.calls,[],route);
  }
});
test('AC-123-05 failed reload remains fail-closed, no private view is revealed',()=>{
  const h=harness('/member/',{reloadThrows:true});
  assert.doesNotThrow(()=>h.runPageShow(true));
  assert.equal(h.document.body.hidden,true);
  assert.deepEqual(h.calls,['reload']);
});
test('AC-123-06 every member-facing application invokes fresh LINE signIn before bootstrap',()=>{
  for(const surface of surfaces){
    const app=fs.readFileSync(path.join(root,surface,'app.js'),'utf8');
    const signin=app.indexOf("MemberSystem.signIn(state.config, '"+surface+"')");
    assert.ok(signin>=0, surface+' must use shared LINE login');
    assert.ok(app.indexOf('MemberSystem.loadConfig()')<signin);
    const bootstrap=app.indexOf("'user."+({member:'member',points:'pointcard',event:'event',calendar:'calendar'})[surface]+".bootstrap'");
    assert.ok(bootstrap>signin,surface+' must verify before private bootstrap');
  }
});
