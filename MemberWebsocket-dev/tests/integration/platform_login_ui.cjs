const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');

const root=path.resolve(__dirname,'../..');
const html=fs.readFileSync(path.join(root,'platform/index.html'),'utf8');
const app=fs.readFileSync(path.join(root,'platform/app.js'),'utf8');
const config={
 platformLiffId:'2012065297-VunxFBj8',
 adminLiffId:'2010791619-vhevCvvD',
 supabaseFunctionUrl:'https://example.supabase.co/functions/v1/api',
 supabasePublishableKey:'test-public-key',
};

test('AC-THEME-001: platform loads the existing theme and mounts a working persistent toggle',()=>{
 const dom=new JSDOM(html,{url:'https://platform.test/platform/',runScripts:'outside-only'});
 try{
  const win=dom.window,d=win.document;
  const themeScript=[...d.scripts].find(script=>new URL(script.src).pathname==='/theme.js');
  assert.ok(themeScript,'Platform must load the shared theme controller');
  assert.ok(d.querySelector('link[href^="../theme.css?"]'),'Platform must load the shared palette');
  win.eval(fs.readFileSync(path.join(root,'theme.js'),'utf8'));
  d.dispatchEvent(new win.Event('DOMContentLoaded'));
  const toggle=d.getElementById('themeToggleButton');
  assert.ok(toggle,'Theme control must be available on the platform');
  assert.equal(d.documentElement.dataset.theme,'light');
  toggle.click();
  assert.equal(d.documentElement.dataset.theme,'dark');
  assert.equal(toggle.getAttribute('aria-pressed'),'true');
  assert.equal(win.localStorage.getItem('lumen-color-theme-v1'),'dark');
  d.getElementById('platformHeader').hidden=true;
  assert.equal(toggle.closest('[hidden]'),null,'Denied identities can still change appearance');
  win.dispatchEvent(new win.StorageEvent('storage',{key:'lumen-color-theme-v1',newValue:'light'}));
  assert.equal(d.documentElement.dataset.theme,'light');
  assert.equal(d.getElementById('platformWorkspace').hidden,true,'Theme never grants workspace access');
 }finally{dom.window.close();}
});
async function until(check){
 for(let i=0;i<80;i++){
  if(check())return;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 throw new Error('Platform initialization did not reach expected UI state');
}
async function boot({loggedIn=false,returning=false,apiStatus=403,merchant=false,business='',decodedToken=null}={}){
 const url='https://platform.test/'+(merchant?'admin/workspace.html':'platform/')+(business?'?business='+encodeURIComponent(business):'');
 const dom=new JSDOM(html,{url,runScripts:'outside-only'});
 const win=dom.window;
 if(merchant)win.document.documentElement.dataset.workspace='merchant';
 if(business)win.BusinessContext={slug:business,configure:async config=>config};
 const calls={init:0,login:0,logout:0,api:0};
 if(!win.AbortSignal.timeout)win.AbortSignal.timeout=()=>new win.AbortController().signal;
 win.MemberSystem={validateConfig(){}};
 win.liff={
  init:async()=>{calls.init++;},
  isLoggedIn:()=>loggedIn,
  isInClient:()=>false,
  getIDToken:()=>loggedIn?'synthetic-verified-token':'',
  getDecodedIDToken:()=>decodedToken,
  logout:()=>{calls.logout++;},
  login:()=>{calls.login++;},
 };
 if(returning)win.sessionStorage.setItem('platform-line-login-return-v1',String(Date.now()));
 win.fetch=async(url,options)=>{
  if(String(url).includes('config.json'))return {ok:true,json:async()=>config};
  assert.equal(options.method,'POST');
  calls.api++;
  const body=JSON.parse(options.body);
  assert.equal(body.action,merchant?'platform.application.bootstrap':'platform.bootstrap');
  assert.equal(body.idToken,'synthetic-verified-token');
  if(apiStatus===401)return {ok:false,status:401,json:async()=>({ok:false,error:{code:'AUTH_INVALID',message:'一般管理員 LINE 登入已失效，請重新登入。'}})};
  if(apiStatus===403)return {ok:false,status:403,json:async()=>({ok:false,error:{code:'PLATFORM_ADMIN_REQUIRED',message:'denied'}})};
  return {ok:true,status:200,json:async()=>({ok:true,data:{features:{membership:'會員卡'},tenants:[],applications:[],profile:{displayName:'已核准人員'}}})};
 };
 win.eval(app);
 return {dom,win,calls};
}

test('AC-UI-001: direct Platform visit starts LINE login without gate or login button',async()=>{
 const h=await boot({loggedIn:false});
 try {
  await until(()=>h.calls.login===1);
  assert.equal(h.calls.init,1);
  assert.equal(h.calls.api,0);
  assert.equal(h.win.document.getElementById('platformLoginButton'),null);
  assert.equal(h.win.document.getElementById('platformLoginGate'),null);
  assert.equal(h.win.document.getElementById('platformWorkspace').hidden,true);
 }finally{h.dom.window.close();}
});

test('AC-MTAB-005: cached LINE Platform session is server-checked without logging out sibling tabs',async()=>{
 const h=await boot({loggedIn:true});
 try {
  await until(()=>h.calls.api===1);
  assert.equal(h.calls.logout,0);
  assert.equal(h.calls.login,0);
  await until(()=>!h.win.document.getElementById('platformAuthorizationNotice').hidden);
  assert.equal(h.win.document.getElementById('platformWorkspace').hidden,true,
    'LINE identity alone must not bypass server approval');
 }finally{h.dom.window.close();}
});

test('AC-UI-003: verified but unapproved LINE user sees only exact approval message',async()=>{
 const h=await boot({loggedIn:true,returning:true});
 try {
  const d=h.win.document;
  await until(()=>!d.getElementById('platformAuthorizationNotice').hidden);
  const notice=d.getElementById('platformAuthorizationNotice');
  assert.equal(notice.textContent.trim(),'總管理員權限尚未核准');
  assert.equal(notice.querySelectorAll('p,button,a,ol,li').length,0);
  assert.equal(d.getElementById('platformStatus').hidden,true);
  assert.equal(d.getElementById('platformHeader').hidden,true);
  assert.equal(d.getElementById('platformWorkspace').hidden,true);
  assert.equal(d.getElementById('platformLoginButton'),null);
  assert.equal(h.calls.api,1);
 }finally{h.dom.window.close();}
});

test('AC-UI-004: server-approved identity reaches workspace without further prompts',async()=>{
 const h=await boot({loggedIn:true,returning:true,apiStatus:200});
 try {
  const d=h.win.document;
  await until(()=>!d.getElementById('platformWorkspace').hidden);
  assert.equal(d.getElementById('platformAuthorizationNotice').hidden,true);
  assert.equal(d.getElementById('platformStatus').hidden,false);
  assert.match(d.getElementById('platformStatus').textContent,/已登入/);
  assert.equal(h.calls.logout,0);
  assert.equal(h.calls.login,0);
 }finally{h.dom.window.close();}
});


test('AC-REAUTH-001: wrong-channel cached LIFF identity must not reach merchant API and offers its dedicated LINE app',async()=>{
 const h=await boot({loggedIn:true,merchant:true,business:'tenant-one',decodedToken:{aud:'2012065297',exp:Math.floor(Date.now()/1000)+1800}});
 try {
  await until(()=>Boolean(h.win.document.getElementById('lineReauthLink')));
  assert.equal(h.calls.api,0,'a platform audience is never submitted as a merchant credential');
  assert.equal(h.calls.logout,0,'a sibling LIFF tab is never logged out');
  assert.equal(h.win.document.getElementById('lineReauthLink').href,'https://liff.line.me/2010791619-vhevCvvD?business=tenant-one');
  assert.equal(h.win.document.getElementById('platformWorkspace').hidden,true);
 }finally{h.dom.window.close();}
});

test('AC-REAUTH-002: expired cached LIFF credential offers scoped re-login without calling the server',async()=>{
 const h=await boot({loggedIn:true,merchant:true,decodedToken:{aud:'2010791619',exp:Math.floor(Date.now()/1000)-10}});
 try {
  await until(()=>Boolean(h.win.document.getElementById('lineReauthLink')));
  assert.equal(h.calls.api,0);
  assert.equal(h.calls.logout,0);
  assert.equal(h.win.document.getElementById('lineReauthLink').href,'https://liff.line.me/2010791619-vhevCvvD');
 }finally{h.dom.window.close();}
});

test('AC-REAUTH-003: LINE verification 401 presents a working per-channel reentry link, never a global logout',async()=>{
 const h=await boot({loggedIn:true,merchant:true,apiStatus:401,decodedToken:{aud:'2010791619',exp:Math.floor(Date.now()/1000)+1800}});
 try {
  await until(()=>Boolean(h.win.document.getElementById('lineReauthLink')));
  const a=h.win.document.getElementById('lineReauthLink');
  assert.equal(a.href,'https://liff.line.me/2010791619-vhevCvvD');
  assert.match(a.textContent,/LINE/);
  assert.equal(h.calls.api,1,'must still server-verify the token');
  assert.equal(h.calls.logout,0);
  assert.equal(h.win.document.getElementById('merchantWorkspace').hidden,true);
 }finally{h.dom.window.close();}
});

test('AC-REAUTH-004: valid channel-specific LIFF credentials keep existing direct-server verification',async()=>{
 const h=await boot({loggedIn:true,merchant:false,decodedToken:{aud:'2012065297',exp:Math.floor(Date.now()/1000)+1800},apiStatus:403});
 try {
  await until(()=>h.calls.api===1);
  assert.equal(h.calls.logout,0);
  assert.equal(h.calls.login,0);
  assert.equal(h.win.document.getElementById('lineReauthLink'),null);
 }finally{h.dom.window.close();}
});


test('AC-REAUTH-006: switching from merchant to Platform never sends the merchant LINE audience to root API',async()=>{
 const h=await boot({loggedIn:true,merchant:false,decodedToken:{aud:'2010791619',exp:Math.floor(Date.now()/1000)+1800}});
 try {
  await until(()=>Boolean(h.win.document.getElementById('lineReauthLink')));
  const link=h.win.document.getElementById('lineReauthLink');
  assert.equal(link.href,'https://liff.line.me/2012065297-VunxFBj8');
  assert.equal(h.calls.api,0,'wrong role and LINE audience must never reach root API');
  assert.equal(h.calls.logout,0,'switching to the Platform page must not log out the merchant tab');
  assert.equal(h.win.document.getElementById('platformWorkspace').hidden,true);
 }finally{h.dom.window.close();}
});
