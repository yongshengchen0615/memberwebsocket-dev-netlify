const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../booking/liff-fresh-login.js'),'utf8');
const entry='https://example.test/booking/?bookingId=fixture#reservation';
const key='booking_system_reauth:booking';
const config={bookingLiffId:'booking-fixture'};

function harness({url=entry,storage=new Map(),loggedIn=true,inClient=false,blockedStorage=false,token='verified-booking-token',logoutNoop=false}={}){
  const calls=[];
  const location={href:url};
  const window={
    crypto:webcrypto,location,
    sessionStorage:{
      getItem(k){if(blockedStorage)throw Error('storage blocked');return storage.get(k)||null;},
      setItem(k,v){if(blockedStorage)throw Error('storage blocked');storage.set(k,v);},
      removeItem(k){if(blockedStorage)throw Error('storage blocked');storage.delete(k);}
    },
    history:{replaceState(_a,_b,next){location.href=new URL(next,location.href).href;}},
    BookingSystem:{signIn:async()=>'original',completeSignIn:async(_c,_t,idToken)=>{calls.push(['claim',idToken]);return idToken;}},
    liff:{
      async init(){calls.push(['init']);},
      isInClient:()=>inClient,
      isLoggedIn:()=>loggedIn,
      logout(){calls.push(['logout']);if(!logoutNoop)loggedIn=false;},
      login(opts){calls.push(['login',opts?.redirectUri]);},
      getIDToken(){calls.push(['token']);return token;}
    }
  };
  vm.runInNewContext(source,{window,document:{title:'Booking'},URL,Date,Uint8Array});
  return {window,storage,location,calls,signIn:()=>window.BookingSystem.signIn(config,'booking')};
}
async function began(opts={}){
  const h=harness(opts);
  void h.signIn();
  await new Promise(resolve=>setImmediate(resolve));
  return {...h,callback:h.calls.find(([name])=>name==='login')?.[1]};
}
test('AC-121-07: booking external entry with cached LINE session requires a nonce-bound login',async()=>{
  const h=await began();
  assert.deepEqual(h.calls.map(a=>a[0]),['init','logout','login']);
  assert.match(new URL(h.callback).searchParams.get('booking_system_reauth'),/^booking\.[a-f0-9]{32}$/);
  assert.equal(h.calls.some(x=>x[0]==='claim'),false);
  assert.ok(h.storage.has(key));
});
test('AC-121-08: booking callback must be bound to this tab/path, consumed once, and server-claimed',async()=>{
  const first=await began();
  const ok=harness({url:first.callback,storage:first.storage});
  assert.equal(await ok.signIn(),'verified-booking-token');
  assert.deepEqual(ok.calls.map(a=>a[0]),['init','token','claim']);
  assert.equal(first.storage.has(key),false);
  assert.equal(ok.location.href,entry);
});
test('AC-121-09: arbitrary login marker cannot bypass new booking login',async()=>{
  const h=harness({url:entry.replace('?bookingId=fixture','?booking_system_reauth=booking&bookingId=fixture')});
  await assert.rejects(h.signIn(),{code:'AUTH_REQUIRED'});
  assert.equal(h.calls.some(x=>x[0]==='token'||x[0]==='claim'),false);
});
for(const variant of ['replay','expired','wrong-path','wrong-nonce','corrupt']){
  test('AC-121-10: '+variant+' booking callback is denied without reusing a token',async()=>{
    const first=await began();
    const record=JSON.parse(first.storage.get(key));
    if(variant==='replay')first.storage.clear();
    if(variant==='expired')record.createdAt=Date.now()-6*60*1000;
    if(variant==='wrong-path')record.pathname='/member/';
    if(variant==='wrong-nonce')record.nonce='0'.repeat(32);
    if(variant!=='replay')first.storage.set(key,variant==='corrupt'?'not-json':JSON.stringify(record));
    const h=harness({url:first.callback,storage:first.storage});
    await assert.rejects(h.signIn(),{code:'AUTH_REQUIRED'});
    assert.equal(h.calls.some(x=>x[0]==='token'||x[0]==='claim'),false);
  });
}
test('AC-121-11: missing browser storage fails closed without claim',async()=>{
  const h=harness({blockedStorage:true});
  await assert.rejects(h.signIn(),{code:'AUTH_STORAGE_UNAVAILABLE'});
  assert.equal(h.calls.some(x=>x[0]==='claim'),false);
});
test('AC-121-12: LINE in-app booking runs ID-token and server session claim without unsupported liff.login',async()=>{
  const h=harness({inClient:true});
  assert.equal(await h.signIn(),'verified-booking-token');
  assert.deepEqual(h.calls.map(x=>x[0]),['init','token','claim']);
});
test('AC-121-13: signed-out returned callback fails instead of endless redirects',async()=>{
  const first=await began({loggedIn:false});
  const returned=harness({url:first.callback,storage:first.storage,loggedIn:false});
  await assert.rejects(returned.signIn(),{code:'AUTH_REQUIRED'});
  assert.equal(returned.calls.some(x=>x[0]==='login'),false);
});
test('AC-121-14: non-booking callers preserve BookingSystem original login',async()=>{
  const h=harness();
  assert.equal(await h.window.BookingSystem.signIn(config,'admin'),'original');
});
