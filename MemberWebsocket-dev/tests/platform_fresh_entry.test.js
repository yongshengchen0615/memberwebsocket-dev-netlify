const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../platform/app.js'),'utf8');
const startPosition=source.lastIndexOf('  async function start() {');
const endPosition=source.lastIndexOf('  void start();');
assert.ok(startPosition>0&&endPosition>startPosition,'platform must retain a named async start function');
const startExpression='('+source.slice(startPosition,endPosition).trim()+')';

function entry({merchantEntry, inClient=false, returned=false, rejected=false, loggedIn=true, idToken='synthetic-line-id-token'}={}) {
  const calls=[];
  const status={textContent:''};
  const featureFields={append(){}};
  const elements={platformStatus:status,featureFields};
  let idTokenValue=idToken;
  const window={
    liff:{
      async init({liffId}){calls.push(['init',liffId]);},
      isLoggedIn(){return loggedIn;},
      isInClient(){return inClient;},
      getIDToken(){calls.push(['token']);return idTokenValue;},
      login(){calls.push(['login']);},
      logout(){calls.push(['logout']);loggedIn=false;}
    },
    MemberSystem:{validateConfig(){calls.push(['config']);}},
    sessionStorage:{getItem(){return null;},setItem(){},removeItem(){calls.push(['clear-attempt']);}},
    location:{href:'https://preview.example.test/admin/'},
    crypto:require('node:crypto').webcrypto
  };
  const context={
    window,URL,AbortSignal,Promise,Date,
    fetch:async()=>({ok:true,json:async()=>({adminLiffId:'2010791619-testAdmin',platformLiffId:'2012065297-testPlatform'})}),
    merchantEntry, rejectedLoginReturn:rejected, refreshTimer:null,
    state:{config:null,idToken:'',features:{}},
    el:id=>elements[id]||status,
    consumeLoginReturn:()=>returned,
    showLoginGate:msg=>calls.push(['gate',msg]),
    markAutomaticLoginAttempt:()=>{calls.push(['attempt']);return true;},
    freshLineLogin:()=>calls.push(['fresh-login']),
    request:async action=>{calls.push(['request',action]);return {profile:{displayName:'測試管理員'},application:{status:'pending'}};},
    renderMine:()=>calls.push(['render-merchant']),
    clearLoginGate:()=>calls.push(['authorized-ui']),
    refresh:async()=>{calls.push(['refresh-root']);return {profile:{displayName:'測試總管理員'},features:{}};},
    refreshMine:()=>{},
    setInterval:()=>1,clearInterval:()=>{},
    document:{createElement:()=>({append(){}}),createTextNode:()=>({})}
  };
  const start=vm.runInNewContext(startExpression,context);
  return {calls,context,run:start};
}
const names=e=>e.calls.map(([name])=>name);

test('AC-121-01: general admin cannot use existing external LINE session without fresh return',async()=>{
  const e=entry({merchantEntry:true});
  await e.run();
  assert.ok(names(e).includes('fresh-login'),'must initiate LINE login on each external entry');
  assert.ok(!names(e).includes('request'),'old session cannot call merchant bootstrap');
  assert.ok(!names(e).includes('authorized-ui'),'old session cannot reveal merchant data');
});
test('AC-121-02: external merchant with genuine callback is still verified by server',async()=>{
  const e=entry({merchantEntry:true,returned:true});
  await e.run();
  assert.deepEqual(e.calls.filter(([name])=>name==='request').map(([,action])=>action),['platform.application.bootstrap']);
  assert.ok(names(e).includes('authorized-ui'));
  assert.ok(!names(e).includes('fresh-login'));
});
test('AC-121-03: LINE in-app browser re-verifies merchant via LIFF and server, no unsupported login',async()=>{
  const e=entry({merchantEntry:true,inClient:true});
  await e.run();
  assert.ok(names(e).includes('request'));
  assert.ok(!names(e).includes('fresh-login'));
});
test('AC-121-04: LINE in-app browser re-verifies platform instead of logout-and-reload cycle',async()=>{
  const e=entry({merchantEntry:false,inClient:true});
  await e.run();
  assert.ok(names(e).includes('refresh-root'));
  assert.ok(!names(e).includes('fresh-login'));
});
test('AC-121-05: rejected external return cannot reuse old LIFF token',async()=>{
  const e=entry({merchantEntry:true,rejected:true});
  await e.run();
  assert.ok(names(e).includes('gate'));
  assert.ok(!names(e).includes('request'));
});
test('AC-121-06: failed ID-token retrieval fails closed before API',async()=>{
  const e=entry({merchantEntry:true,inClient:true,idToken:''});
  await e.run();
  assert.ok(names(e).includes('gate'));
  assert.ok(!names(e).includes('request'));
});
