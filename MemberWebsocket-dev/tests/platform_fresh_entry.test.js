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

function entry({merchantEntry, inClient=false, returned=false, rejected=false, loggedIn=true, idToken='synthetic-line-id-token',version=1,business='',configuredLiff,platformLiffId='2012065297-testPlatform',initialEntry=false}={}) {
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
    LineInitialEntry:{enter({liffId,scope,business}){calls.push(['initial-entry',scope,liffId,business]);return initialEntry;}},
    sessionStorage:{getItem(){return null;},setItem(){},removeItem(){calls.push(['clear-attempt']);}},
    location:{href:'https://preview.example.test/admin/'},
    crypto:require('node:crypto').webcrypto
  };
  if(configuredLiff)window.BusinessContext={configure:async config=>{calls.push(['configure-business']);return{...config,adminLiffId:configuredLiff};}};
  const context={
    window,URL,AbortSignal,Promise,Date,setTimeout,clearTimeout,
    fetch:async url=>{calls.push(['fetch-config',url]);return{ok:true,json:async()=>({merchantApprovalVersion:version,adminLiffId:'2010791619-testAdmin',platformLiffId})};},
    merchantEntry, rejectedLoginReturn:rejected, refreshTimer:null,
    state:{config:null,idToken:'',features:{}},
    isV2:()=>version===2,isAccount:()=>false,selectedBusiness:business,
    el:id=>elements[id]||status,
    consumeLoginReturn:()=>returned,
    showLoginGate:msg=>calls.push(['gate',msg]),
    markAutomaticLoginAttempt:()=>{calls.push(['attempt']);return true;},
    freshLineLogin:()=>calls.push(['fresh-login']),
    cachedLineIdentityInvalid:()=>false,
    autoReenterOnce:()=>calls.push(['scoped-line-reentry']),
    clearAutomaticReentry:()=>calls.push(['clear-scoped-reentry']),
    offerLineReentry:()=>calls.push(['offer-scoped-reentry']),
    request:async action=>{calls.push(['request',action]);return {profile:{displayName:'測試管理員'},application:{status:'pending'}};},
    renderMine:()=>calls.push(['render-merchant']),
    clearLoginGate:()=>calls.push(['authorized-ui']),
    refresh:async()=>{calls.push(['refresh-root']);return {profile:{displayName:'測試總管理員'},features:{}};},
    refreshMine:()=>{},
    setInterval:()=>1,clearInterval:()=>{},
    document:{createElement:()=>({append(){}}),createTextNode:()=>({}),querySelector:()=>null}
  };
  const start=vm.runInNewContext(startExpression,context);
  return {calls,context,run:start};
}
const names=e=>e.calls.map(([name])=>name);

test('AC-MTAB-007: cached LINE merchant identity is always revalidated by its server without logging out other tabs',async()=>{
  const e=entry({merchantEntry:true});
  await e.run();
  assert.deepEqual(e.calls.filter(([name])=>name==='request').map(([,action])=>action),['platform.application.bootstrap']);
  assert.ok(names(e).includes('authorized-ui'),'merchant UI only follows the server-approved response');
  assert.ok(!names(e).includes('fresh-login'));
  assert.ok(!names(e).includes('logout'));
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
test('AC-MMA-LOGIN-001: selected LINE workspace initializes the server-selected merchant LIFF instead of the account LIFF',async()=>{
 const e=entry({merchantEntry:true,inClient:true,version:2,business:'merchant-a',configuredLiff:'2099999999-customAdmin'});
 await e.run();
 assert.ok(names(e).includes('configure-business'));
 assert.deepEqual(e.calls.filter(([name])=>name==='init').map(([,id])=>id),['2099999999-customAdmin']);
 assert.ok(names(e).includes('request'));assert.ok(names(e).includes('authorized-ui'));
});

test('AC-PLATFORM-LIFF-001: master uses the new configured root-admin LIFF ID from config folder',async()=>{
  const id='2011356226-uCfdWtVp';
  const e=entry({merchantEntry:false,inClient:true,platformLiffId:id});
  await e.run();
  assert.deepEqual(e.calls.filter(([name])=>name==='fetch-config').map(([,url])=>url),['../config/config.json']);
  assert.deepEqual(e.calls.filter(([name])=>name==='init').map(([,value])=>value),[id]);
  assert.ok(names(e).includes('refresh-root'),'authorization still occurs server-side');
  assert.ok(!names(e).includes('gate'));
});

test('AC-PLATFORM-LIFF-002: malformed LIFF is blocked before init or privileged API',async()=>{
  const e=entry({merchantEntry:false,inClient:true,platformLiffId:'not-a-liff'});
  await e.run();
  assert.equal(names(e).includes('init'),false);
  assert.equal(names(e).includes('refresh-root'),false);
  assert.ok(e.calls.some(([name,message])=>name==='gate'&&message.includes('總管理員專用 LIFF')));
});


test('AC-REAUTH-005: wrong LIFF audience remains private and shows the explicit scoped entry after initial attempt',async()=>{
 const e=entry({merchantEntry:true});
 e.context.cachedLineIdentityInvalid=()=>true;
 await e.run();
 assert.ok(names(e).includes('offer-scoped-reentry'));
 assert.ok(!names(e).includes('scoped-line-reentry'),'wrong audience must not loop through LIFF again');
 assert.ok(!names(e).includes('request'));
 assert.ok(!names(e).includes('logout'));
});


test('AC-REAUTH-007: server AUTH_INVALID rejects current session with a reentry link but no automatic navigation',async()=>{
 const e=entry({merchantEntry:true});
 e.context.request=async action=>{
  e.calls.push(['request',action]);
  throw Object.assign(new Error('LINE credential is invalid'),{code:'AUTH_INVALID',status:401});
 };
 await e.run();
 assert.ok(names(e).includes('gate'),'failed server authorization must hide private UI');
 assert.ok(names(e).includes('offer-scoped-reentry'),'failed sign-in must offer the dedicated LINE URL');
 assert.equal(names(e).includes('scoped-line-reentry'),false,'server denial must not automatically navigate or mask the error');
 assert.equal(names(e).includes('authorized-ui'),false);
});


test('AC-LINE-009: a new merchant tab enters its configured merchant LIFF before reading cached tokens or merchant data',async()=>{
 const e=entry({merchantEntry:true,version:2,business:'shop-a',configuredLiff:'2099999999-merchant',initialEntry:true});
 await e.run();
 assert.ok(names(e).includes('init'));
 assert.deepEqual(e.calls.filter(([name])=>name==='initial-entry').map(([,scope,id,business])=>[scope,id,business]),[['merchant','2099999999-merchant','shop-a']]);
 assert.equal(names(e).includes('token'),false);
 assert.equal(names(e).includes('request'),false);
 assert.equal(names(e).includes('logout'),false);
});

test('AC-LINE-010: a newly opened root Platform tab enters root LIFF without reusing the merchant tab identity',async()=>{
 const e=entry({merchantEntry:false,initialEntry:true});
 await e.run();
 assert.deepEqual(e.calls.filter(([name])=>name==='initial-entry').map(([,scope,id])=>[scope,id]),[['platform','2012065297-testPlatform']]);
 assert.equal(names(e).includes('refresh-root'),false);
 assert.equal(names(e).includes('token'),false);
});
