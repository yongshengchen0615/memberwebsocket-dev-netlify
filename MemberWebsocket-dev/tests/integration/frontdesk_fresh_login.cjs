const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../frontdesk/app.js'),'utf8');
const entry='https://frontdesk.test/frontdesk/?business=shop-a&bookingId=fixture';
const key='frontdesk_line_reauth:shop-a';
const fixtureHtml='<!doctype html><html><head><title>Frontdesk</title></head><body>'+
 '<h1 id="businessName"></h1><p id="status" role="status"></p><ol id="progress"></ol>'+
 '<section id="account"></section><div class="frontdesk-toolbar"><h2></h2><p id="bookingSummary"></p>'+
 '<button id="refresh">重新整理</button></div><section id="bookings"></section></body></html>';

async function session({url=entry,storage=new Map(),loggedIn=true,inClient=false,token='verified-id-token',
  storageBlocked=false,logoutFails=false,logoutNoop=false,initFails=false,
  bootstrapError=null,permissionMode='notify_only'}={}){
 const dom=new JSDOM(fixtureHtml,{url,runScripts:'outside-only'});
 const w=dom.window,calls=[];
 Object.defineProperty(w,'sessionStorage',{configurable:true,value:{
   getItem(k){if(storageBlocked)throw Error('disabled');return storage.get(k)||null;},
   setItem(k,v){if(storageBlocked)throw Error('disabled');storage.set(k,v);},
   removeItem(k){if(storageBlocked)throw Error('disabled');storage.delete(k);}
 }});
 w.liff={
   async init(input){calls.push(['init',input.liffId]);if(initFails)throw Error('init failed');},
   isInClient:()=>inClient,isLoggedIn:()=>loggedIn,
   logout(){calls.push(['logout']);if(logoutFails)throw Error('logout fails');if(!logoutNoop)loggedIn=false;},
   login(opts){calls.push(['login',opts.redirectUri]);},
   getIDToken(){calls.push(['token']);return token;}
 };
 w.fetch=async(_url,opts)=>{
   if(!opts?.body)return{ok:true,json:async()=>({
     supabaseFunctionUrl:'https://db.test/functions/v1/api',supabasePublishableKey:'public'
   })};
   const input=JSON.parse(opts.body);calls.push(['request',input.action,input.idToken]);
   if(input.action==='frontdesk.bootstrap'&&bootstrapError)return{
     ok:false,status:401,json:async()=>({ok:false,error:{code:bootstrapError,message:'LINE 身分失效'}})
   };
   const data=input.action==='frontdesk.public'
     ? {name:'商家',frontdesk:{enabled:true,liffId:'2010999999-desk'}}
     :input.action==='frontdesk.bootstrap'
     ? {staff:{displayName:'櫃檯人員',status:'approved',permissionMode}}
     : {bookings:[{id:'booking-a',status:'pending',name:'私有預約',updatedAt:'v1',services:[]}]};
   return{ok:true,status:200,json:async()=>({ok:true,data})};
 };
 const ready=new Promise(resolve=>w.addEventListener('frontdesk-ready',resolve,{once:true}));
 w.eval(source);await ready;
 return{
   dom,w,storage,calls,
   redirect:calls.find(([a])=>a==='login')?.[1],
   actions:calls.filter(([a])=>a==='request').map(x=>x[1]),
   callsNamed:name=>calls.filter(([a])=>a===name),
   close:()=>w.close()
 };
}
test('AC-FD-AUTH-001: fresh external entry logs out a cached LIFF user and never loads protected bookings',async()=>{
 const h=await session();
 try{
   assert.deepEqual(h.calls.filter(x=>x[0]!=='request').map(x=>x[0]),['init','logout','login']);
   assert.equal(h.actions.includes('frontdesk.public'),true);
   assert.equal(h.actions.includes('frontdesk.bootstrap'),false);
   assert.equal(h.callsNamed('token').length,0);
   assert.equal(h.w.document.querySelectorAll('#account button').length,0);
   const u=new URL(h.redirect),marker=u.searchParams.get('frontdesk_line_reauth');
   assert.match(marker,/^[a-f0-9]{32}$/);
   assert.equal(u.searchParams.get('business'),'shop-a');
   assert.equal(u.searchParams.get('bookingId'),'fixture');
   assert.equal(JSON.parse(h.storage.get(key)).nonce,marker);
   assert.equal(h.storage.get(key).includes('verified-id-token'),false);
 }finally{h.close();}
});
test('AC-FD-AUTH-002: signed-out external entry uses LINE Login without redundant logout',async()=>{
 const h=await session({loggedIn:false});
 try{
  assert.deepEqual(h.calls.filter(x=>x[0]!=='request').map(x=>x[0]),['init','login']);
  assert.equal(h.actions.includes('frontdesk.bootstrap'),false);
 }finally{h.close();}
});
test('AC-FD-AUTH-003: only matching one-time callback can open approved staff page',async()=>{
 const first=await session();
 const callback=first.redirect,storage=first.storage;first.close();
 const fresh=await session({url:callback,storage});
 try{
  assert.deepEqual(fresh.calls.filter(x=>x[0]!=='request').map(x=>x[0]),['init','token']);
  assert.deepEqual(fresh.actions.slice(0,2),['frontdesk.public','frontdesk.bootstrap']);
  assert.equal(storage.has(key),false);
  assert.equal(fresh.w.location.href,entry);
  assert.equal(fresh.w.document.querySelectorAll('#account button').length,0);
  assert.match(fresh.w.document.getElementById('account').textContent,/已核准/);
 }finally{fresh.close();}
 const reopened=await session({url:entry,storage});
 try{
  assert.deepEqual(reopened.calls.filter(x=>x[0]!=='request').map(x=>x[0]),['init','logout','login']);
  assert.equal(reopened.actions.includes('frontdesk.bootstrap'),false);
 }finally{reopened.close();}
});
for(const mode of ['missing','expired','future','wrong-nonce','wrong-path','wrong-tenant','corrupt']){
 test('AC-FD-AUTH-004: '+mode+' callback denies reuse of prior LINE identity',async()=>{
  const first=await session();const storage=first.storage;let callback=first.redirect;first.close();
  const record=JSON.parse(storage.get(key));
  if(mode==='missing')storage.delete(key);
  if(mode==='expired')record.createdAt=Date.now()-6*60*1000;
  if(mode==='future')record.createdAt=Date.now()+60*1000;
  if(mode==='wrong-nonce')record.nonce='0'.repeat(32);
  if(mode==='wrong-path')record.pathname='/other/';
  if(mode==='wrong-tenant')record.business='another-tenant';
  if(mode==='corrupt')storage.set(key,'not-json');
  else if(mode!=='missing')storage.set(key,JSON.stringify(record));
  const h=await session({url:callback,storage});
  try{
   assert.equal(h.actions.includes('frontdesk.bootstrap'),false);
   assert.equal(h.callsNamed('token').length,0);
   assert.equal(h.callsNamed('login').length,0,'invalid callbacks must not redirect forever');
   assert.match(h.w.document.getElementById('status').textContent,/登入回跳/);
   assert.equal(h.w.document.querySelector('#account button'),null);
  }finally{h.close();}
 });
}
test('AC-FD-AUTH-005: missing browser storage fails closed, including previously logged-in users',async()=>{
 const h=await session({storageBlocked:true});
 try{
  assert.equal(h.callsNamed('login').length,0);
  assert.equal(h.callsNamed('token').length,0);
  assert.equal(h.actions.includes('frontdesk.bootstrap'),false);
  assert.match(h.w.document.getElementById('status').textContent,/儲存空間/);
 }finally{h.close();}
});
for(const mode of ['logoutFails','logoutNoop']){
 test('AC-FD-AUTH-006: '+mode+' cannot silently reuse a prior LINE session',async()=>{
  const h=await session({[mode]:true});
  try{
   assert.equal(h.callsNamed('login').length,0);
   assert.equal(h.callsNamed('token').length,0);
   assert.equal(h.actions.includes('frontdesk.bootstrap'),false);
   assert.match(h.w.document.getElementById('status').textContent,/先前|無法清除/);
  }finally{h.close();}
 });
}
test('AC-FD-AUTH-007: LINE LIFF browser automatically signs in and server validates on each entry',async()=>{
 const h=await session({inClient:true,permissionMode:'review'});
 try{
  assert.deepEqual(h.calls.filter(x=>x[0]!=='request').map(x=>x[0]),['init','token']);
  assert.deepEqual(h.actions.slice(0,3),['frontdesk.public','frontdesk.bootstrap','frontdesk.bookings']);
  assert.equal(h.calls.find(x=>x[1]==='frontdesk.bootstrap')?.[2],'verified-id-token');
  assert.match(h.w.document.getElementById('bookings').textContent,/私有預約/);
  const readyAgain=new Promise(resolve=>h.w.addEventListener('frontdesk-ready',resolve,{once:true}));
  h.w.dispatchEvent(new h.w.Event('pagehide'));
  assert.equal(h.w.document.getElementById('bookings').textContent,'');
  const event=new h.w.Event('pageshow');Object.defineProperty(event,'persisted',{value:true});
  h.w.dispatchEvent(event);await readyAgain;
  assert.equal(h.callsNamed('init').length,2,'bfcache resume must freshly initialize LIFF');
  assert.equal(h.actions.filter(x=>x==='frontdesk.bootstrap').length,2,'server validates identity again');
 }finally{h.close();}
});
test('AC-FD-AUTH-008: LIFF client without signed-in identity is denied without unsupported login',async()=>{
 const h=await session({inClient:true,loggedIn:false});
 try{
  assert.equal(h.callsNamed('login').length,0);
  assert.equal(h.callsNamed('token').length,0);
  assert.equal(h.actions.includes('frontdesk.bootstrap'),false);
  assert.match(h.w.document.getElementById('status').textContent,/尚未完成登入/);
 }finally{h.close();}
});
test('AC-FD-AUTH-009: external login return without a LINE session fails without redirect loop',async()=>{
 const first=await session();const {storage,redirect}=first;first.close();
 const h=await session({storage,url:redirect,loggedIn:false});
 try{
  assert.equal(h.callsNamed('login').length,0);
  assert.equal(h.callsNamed('token').length,0);
  assert.equal(h.actions.includes('frontdesk.bootstrap'),false);
  assert.match(h.w.document.getElementById('status').textContent,/LINE 登入未完成/);
 }finally{h.close();}
});
test('AC-FD-AUTH-010: missing ID token never reaches protected API',async()=>{
 const h=await session({inClient:true,token:''});
 try{
  assert.equal(h.actions.includes('frontdesk.bootstrap'),false);
  assert.equal(h.w.document.querySelectorAll('#bookings button').length,0);
  assert.match(h.w.document.getElementById('status').textContent,/無法取得 LINE 身分憑證/);
 }finally{h.close();}
});
test('AC-FD-AUTH-011: invalid server LINE token leaves no re-login button or private data',async()=>{
 const h=await session({inClient:true,bootstrapError:'FRONTDESK_AUTH_INVALID'});
 try{
  assert.equal(h.actions.includes('frontdesk.bootstrap'),true);
  assert.equal(h.w.document.querySelectorAll('#account button').length,0);
  assert.equal(h.w.document.getElementById('bookings').textContent,'');
  assert.match(h.w.document.getElementById('status').textContent,/LINE 身分已失效/);
  h.w.document.getElementById('refresh').click();
  assert.equal(h.actions.filter(x=>x==='frontdesk.bootstrap').length,1,
    'manual refresh may not send an empty/expired token');
 }finally{h.close();}
});
test('AC-FD-AUTH-012: no manual re-login UI is generated anywhere in the frontdesk page',()=>{
 assert.doesNotMatch(source,/重新登入 LINE|node\('button','重新登入/);
 const html=fs.readFileSync(path.join(__dirname,'../../frontdesk/index.html'),'utf8');
 assert.doesNotMatch(html,/重新登入 LINE/);
 assert.match(html,/app\.js\?v=20261121-fresh-line-entry1/);
});
