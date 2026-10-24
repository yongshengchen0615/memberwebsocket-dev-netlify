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
 supabaseFunctionUrl:'https://example.supabase.co/functions/v1/api',
 supabasePublishableKey:'test-public-key',
};
async function until(check){
 for(let i=0;i<80;i++){
  if(check())return;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 throw new Error('Platform initialization did not reach expected UI state');
}
async function boot({loggedIn=false,returning=false,apiStatus=403}={}){
 const dom=new JSDOM(html,{url:'https://platform.test/platform/',runScripts:'outside-only'});
 const win=dom.window;
 const calls={init:0,login:0,logout:0,api:0};
 if(!win.AbortSignal.timeout)win.AbortSignal.timeout=()=>new win.AbortController().signal;
 win.MemberSystem={validateConfig(){}};
 win.liff={
  init:async()=>{calls.init++;},
  isLoggedIn:()=>loggedIn,
  isInClient:()=>false,
  getIDToken:()=>loggedIn?'synthetic-verified-token':'',
  logout:()=>{calls.logout++;},
  login:()=>{calls.login++;},
 };
 if(returning)win.sessionStorage.setItem('platform-line-login-return-v1',String(Date.now()));
 win.fetch=async(url,options)=>{
  if(String(url).includes('config.json'))return {ok:true,json:async()=>config};
  assert.equal(options.method,'POST');
  calls.api++;
  const body=JSON.parse(options.body);
  assert.equal(body.action,'platform.bootstrap');
  assert.equal(body.idToken,'synthetic-verified-token');
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

test('AC-UI-002: an existing LINE session is freshly authenticated on Platform entry',async()=>{
 const h=await boot({loggedIn:true});
 try {
  await until(()=>h.calls.login===1);
  assert.equal(h.calls.logout,1);
  assert.equal(h.calls.api,0,'a pre-existing LIFF session alone must not access Platform');
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
