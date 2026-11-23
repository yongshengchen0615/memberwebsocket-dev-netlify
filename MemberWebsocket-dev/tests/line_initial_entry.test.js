const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const source=()=>fs.readFileSync(path.join(root,'line-initial-entry.js'),'utf8');
const ID={platform:'2012065297-RootChannel',merchant:'2010791619-MerchantChannel',member:'2010787602-MemberChannel',booking:'2010787602-BookingChannel',frontdesk:'2010787602-FrontdeskChannel'};
function visit({url='https://example.netlify.app/platform/',scope='platform',liffId=ID.platform,business='',loggedIn=true,inClient=false,decodedToken=null,storage=new Map(),storageBlocked=false}={}) {
 const calls=[];
 const location={href:url,replace(href){calls.push(['replace',href]);}};
 const window={location,liff:{isInClient:()=>inClient,isLoggedIn:()=>loggedIn,getDecodedIDToken:()=>decodedToken,logout(){calls.push(['logout']);}},
  sessionStorage:{
   getItem(k){if(storageBlocked)throw Error('storage unavailable');return storage.get(k)||null;},
   setItem(k,v){if(storageBlocked)throw Error('storage unavailable');storage.set(k,v);},
   removeItem(k){if(storageBlocked)throw Error('storage unavailable');storage.delete(k);}
  }
 };
 vm.runInNewContext(source(),{window,URL,Date});
 return {calls,window,storage,enter:()=>window.LineInitialEntry.enter({liffId,scope,business})};
}
test('AC-LINE-001: external authenticated platform entry starts its own LINE LIFF before reusing any other app session',()=>{
 const h=visit();
 assert.equal(h.enter(),true);
 const redirect=h.calls.find(c=>c[0]==='replace')?.[1];
 assert.equal(new URL(redirect).origin,'https://liff.line.me');
 assert.equal(new URL(redirect).pathname,'/'+ID.platform);
 assert.equal(new URL(redirect).searchParams.get('line_initial'),'1');
 assert.equal(h.calls.some(c=>c[0]==='logout'),false);
});
test('AC-LINE-002: merchant, member and booking require their own LIFF on a new tab, not the previous app state',()=>{
 for(const [scope,pathname] of [['merchant','/admin/workspace.html'],['member','/member/'],['booking','/booking/'],['frontdesk','/frontdesk/']]){
  const h=visit({scope,liffId:ID[scope],url:'https://example.netlify.app'+pathname+'?business=shop-a&bookingId=ref-1',business:'shop-a'});
  assert.equal(h.enter(),true,scope);
  const url=new URL(h.calls[0][1]);
  assert.equal(url.pathname,'/'+ID[scope],scope);
  assert.equal(url.searchParams.get('business'),'shop-a',scope);
  assert.equal(url.searchParams.get('bookingId'),'ref-1',scope);
  assert.equal(h.calls.some(c=>c[0]==='logout'),false);
 }
});
test('AC-LINE-003: LINE primary/secondary callback retains SDK URL and cannot enter a redirect loop',()=>{
 for(const url of [
  'https://example.netlify.app/platform/?liff.state=%3Fline_initial%3D1',
  'https://example.netlify.app/platform/?line_initial=1',
  'https://example.netlify.app/platform/?code=opaque&state=opaque',
  'https://example.netlify.app/platform/?access_token=opaque'
 ]){
  const h=visit({url});
  assert.equal(h.enter(),false,url);
  assert.equal(h.calls.length,0,url);
 }
 const h=visit();
 assert.equal(h.enter(),true);
 assert.equal(h.enter(),false,'same tab and LIFF cannot start a second login within the callback window');
 assert.equal(h.calls.length,1);
});
test('AC-LINE-004: every new browser tab obtains its own initial LIFF even if another tab already entered',()=>{
 const a=visit(),b=visit();
 assert.equal(a.enter(),true);
 assert.equal(b.enter(),true);
 assert.equal(a.calls.length,1);
 assert.equal(b.calls.length,1);
});
test('AC-LINE-005: LINE in-app browser initializes itself; signed-out external browser uses existing liff.login',()=>{
 for(const opts of [{inClient:true},{loggedIn:false},{url:'http://127.0.0.1:5000/platform/'}]){
  const h=visit(opts);
  assert.equal(h.enter(),false);
  assert.equal(h.calls.length,0);
 }
});
test('AC-LINE-006: missing storage, invalid LIFF ID, and insecure redirect parameters do not cause unbounded navigation',()=>{
 for(const opts of [{storageBlocked:true},{liffId:'not-a-liff'},{liffId:'//attacker.tld'}]){
  const h=visit(opts);assert.equal(h.enter(),false);assert.equal(h.calls.length,0);
 }
 const h=visit({url:'https://example.netlify.app/member/?business=shop-a&code=abc',scope:'member',liffId:ID.member});
 assert.equal(h.enter(),true);
 const url=new URL(h.calls[0][1]);
 assert.equal(url.searchParams.get('code'),null);
 assert.equal(url.searchParams.get('business'),'shop-a');
});
test('AC-LINE-007: all protected LINE pages load the shared entry coordinator before their application',()=>{
 for(const file of ['platform/index.html','admin/index.html','admin/workspace.html','member/index.html','points/index.html','event/index.html','calendar/index.html','booking/index.html','frontdesk/index.html','admin/frontdesk-settings/index.html']){
  const html=fs.readFileSync(path.join(root,file),'utf8');
  assert.match(html,/line-initial-entry\.js/,'missing entry coordinator: '+file);
 }
});
test('AC-LINE-008: protected entrypoints call the coordinator as part of their own fresh LIFF initialization',()=>{
 for(const file of ['platform/app.js','member-system.js','booking/liff-fresh-login.js','frontdesk/app.js','admin/frontdesk-settings/frontdesk-settings-page.js']){
  const code=fs.readFileSync(path.join(root,file),'utf8');
  assert.match(code,/LineInitialEntry\?\.enter\(/,'missing per-page login contract: '+file);
 }
});


test('AC-LINE-014: an in-LINE tab with another Channel audience enters its own LIFF instead of showing a stale-token warning',()=>{
 const h=visit({inClient:true,scope:'platform',decodedToken:{aud:'2010791619'}});
 assert.equal(h.enter(),true);
 assert.equal(new URL(h.calls[0][1]).pathname,'/'+ID.platform);
 assert.equal(h.calls.some(([name])=>name==='logout'),false);
 const correct=visit({inClient:true,scope:'platform',decodedToken:{aud:'2012065297'}});
 assert.equal(correct.enter(),false,'the LIFF SDK already initialized this app inside LINE');
 assert.equal(correct.calls.length,0);
});


test('AC-LINE-015: invalid or replayed application callback is handled by its owner, never bypassed by an automatic LIFF link',()=>{
 for(const name of ['member_system_reauth','booking_system_reauth','frontdesk_line_reauth']){
  const h=visit({url:'https://example.netlify.app/member/?'+name+'=forged-nonce',scope:'member',liffId:ID.member});
  assert.equal(h.enter(),false,name);
  assert.equal(h.calls.length,0,name);
 }
});

test('AC-LINE-016: the initial official link never carries OAuth codes or token-like query secrets',()=>{
 const h=visit({url:'https://example.netlify.app/member/?business=shop-a&code=secret&access_token=private&jwt=secret&api_key=secret&bookingId=ref-1',scope:'member',liffId:ID.member});
 assert.equal(h.enter(),false,'an SDK access token callback is never re-routed before sdk init');
 const safe=visit({url:'https://example.netlify.app/member/?business=shop-a&jwt=secret&api_key=secret&bookingId=ref-1',scope:'member',liffId:ID.member});
 assert.equal(safe.enter(),true);
 const link=new URL(safe.calls[0][1]);
 assert.equal(link.searchParams.get('business'),'shop-a');
 assert.equal(link.searchParams.get('bookingId'),'ref-1');
 assert.equal(link.searchParams.has('jwt'),false);
 assert.equal(link.searchParams.has('api_key'),false);
});


test('AC-LINE-019: productized /admin/ dynamically loads the refreshed merchant LIFF application, not an old cached script',()=>{
 const dynamic=fs.readFileSync(path.join(root,'admin/productized-workspace.js'),'utf8');
 const shell=fs.readFileSync(path.join(root,'admin/index.html'),'utf8');
 assert.match(dynamic,/platform\/app\.js\?[^'"]*line=20261123-initial-1/);
 assert.match(shell,/productized-workspace\.js\?[^"]*line=20261123-initial-1/);
});
