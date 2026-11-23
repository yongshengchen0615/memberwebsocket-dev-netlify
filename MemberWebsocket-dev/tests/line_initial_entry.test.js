const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const source=()=>fs.readFileSync(path.join(root,'line-initial-entry.js'),'utf8');
const ID={platform:'2012065297-RootChannel',merchant:'2010791619-MerchantChannel',member:'2010787602-MemberChannel',booking:'2010787602-BookingChannel',frontdesk:'2010787602-FrontdeskChannel'};
function visit({url='https://example.netlify.app/platform/',scope='platform',liffId=ID.platform,business='',loggedIn=true,inClient=false,decodedToken=null,storage=new Map(),storageBlocked=false,userAgent='Mozilla/5.0 Chrome/130'}={}) {
 const calls=[];
 const location={href:url,replace(href){calls.push(['replace',href]);}};
 const window={location,navigator:{userAgent},liff:{isInClient:()=>inClient,isLoggedIn:()=>loggedIn,getDecodedIDToken:()=>decodedToken,logout(){calls.push(['logout']);}},
  sessionStorage:{
   getItem(k){if(storageBlocked)throw Error('storage unavailable');return storage.get(k)||null;},
   setItem(k,v){if(storageBlocked)throw Error('storage unavailable');storage.set(k,v);},
   removeItem(k){if(storageBlocked)throw Error('storage unavailable');storage.delete(k);}
  }
 };
 vm.runInNewContext(source(),{window,URL,Date});
 return {calls,window,storage,enter:()=>window.LineInitialEntry.enter({liffId,scope,business})};
}
test('AC-ROLL-005: an existing valid same-channel ID token uses native LIFF init and server verification without another redirect',()=>{
 for(const inClient of [false,true]){
  const claims={aud:'2012065297',exp:Date.now()/1000+300};
  const h=visit({decodedToken:claims,inClient});
  assert.equal(h.window.LineInitialEntry.enterBeforeInit({liffId:ID.platform,scope:'platform'}),false);
  assert.equal(h.enter(),false);
  assert.equal(h.calls.length,0,'valid identity is verified by the caller; this helper must not reroute');
 }
});
test('AC-ROLL-006: wrong-channel, expired and invalid claims cannot bypass dedicated LIFF entry',()=>{
 const cases=[{aud:'2010791619',exp:Date.now()/1000+300},{aud:'2012065297',exp:Date.now()/1000-1},{aud:'2012065297',exp:'not-a-time'}];
 for(const decodedToken of cases){
  const h=visit({decodedToken});
  assert.equal(h.window.LineInitialEntry.enterBeforeInit({liffId:ID.platform,scope:'platform'}),true);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls.some(([name])=>name==='logout'),false);
 }
});
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
test('AC-ROLL-014: every LINE-protected page uses Nov22 native LIFF startup without Nov23 coordinator',()=>{
 for(const file of ['platform/index.html','admin/index.html','admin/workspace.html','member/index.html','points/index.html','event/index.html','calendar/index.html','booking/index.html','frontdesk/index.html','admin/frontdesk-settings/index.html']){
  const html=fs.readFileSync(path.join(root,file),'utf8');
  assert.doesNotMatch(html,/line-initial-entry\\.js/,'Nov23 automatic entry must be absent: '+file);
 }
});
test('AC-ROLL-015: Nov22 LINE application startup does not use Nov23 coordinator',()=>{
 for(const file of ['platform/app.js','member-system.js','booking/liff-fresh-login.js','booking/common.js','frontdesk/app.js','admin/frontdesk-settings/frontdesk-settings-page.js']){
  const code=fs.readFileSync(path.join(root,file),'utf8');
  assert.doesNotMatch(code,/LineInitialEntry/,'legacy startup does not call coordinator: '+file);
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


test('AC-ROLL-016: dynamic admin loads Nov22 Platform app rather than Nov23 auto-recovery module',()=>{
 const dynamic=fs.readFileSync(path.join(root,'admin/productized-workspace.js'),'utf8');
 const shell=fs.readFileSync(path.join(root,'admin/index.html'),'utf8');
 assert.ok(dynamic.includes("platform/app.js?v=merchant-expiry-readonly-20261101-1"));
 assert.doesNotMatch(dynamic,/autorecover=20261123|line=20261123/);
 assert.doesNotMatch(shell,/autorecover=20261123|line=20261123/);
});
test('AC-LINE-020: a new tab enters its own LIFF before any SDK init or cached identity inspection',()=>{
 const h=visit({loggedIn:false,inClient:false,scope:'merchant',liffId:ID.merchant,url:'https://example.netlify.app/admin/?business=shop-a'});
 h.window.liff.isLoggedIn=()=>{throw Error('SDK has not initialized');};
 h.window.liff.isInClient=()=>{throw Error('SDK has not initialized');};
 assert.equal(h.window.LineInitialEntry.enterBeforeInit({liffId:ID.merchant,scope:'merchant',business:'shop-a'}),true);
 assert.equal(new URL(h.calls[0][1]).pathname,'/'+ID.merchant);
 assert.equal(h.calls.some(x=>x[0]==='logout'),false);
 assert.equal(h.window.LineInitialEntry.enterBeforeInit({liffId:ID.merchant,scope:'merchant',business:'shop-a'}),false,'one navigation only per tab');
});
test('AC-LINE-021: SDK primary/secondary redirects are untouched before init, including forged application reauth callbacks',()=>{
 for(const query of ['liff.state=%3Fbusiness%3Dshop-a','code=abc&state=xyz','access_token=opaque','line_initial=1','member_system_reauth=forged']){
  const h=visit({url:'https://example.netlify.app/member/?'+query,loggedIn:false});
  assert.equal(h.window.LineInitialEntry.enterBeforeInit({liffId:ID.member,scope:'member'}),false,query);
  assert.equal(h.calls.length,0,query);
 }
});
test('AC-ROLL-017: Nov22 entrypoints initialize each LIFF without a pre-init redirect',()=>{
 for(const file of ['platform/app.js','member-system.js','booking/common.js','booking/liff-fresh-login.js','frontdesk/app.js','admin/frontdesk-settings/frontdesk-settings-page.js']){
  const code=fs.readFileSync(path.join(root,file),'utf8');
  assert.match(code,/window\\.liff\\.init\\(/,'LIFF initialization must remain: '+file);
  assert.doesNotMatch(code,/enterBeforeInit|LineInitialEntry/,'no Nov23 pre-init redirect: '+file);
 }
});
test('AC-LINE-027: LINE in-app browser initializes its own LIFF without pre-init external navigation',()=>{
 const opts={scope:'merchant',liffId:ID.merchant,loggedIn:false};
 const sdk=visit({...opts,inClient:true});
 assert.equal(sdk.window.LineInitialEntry.enterBeforeInit({liffId:ID.merchant,scope:'merchant'}),false);
 assert.equal(sdk.calls.length,0);
 const ua=visit({...opts,userAgent:'Mozilla/5.0 (iPhone) AppleWebKit/605.1 LINE/14.19.1'});
 ua.window.liff.isInClient=()=>{throw Error('LIFF has not initialized');};
 assert.equal(ua.window.LineInitialEntry.enterBeforeInit({liffId:ID.merchant,scope:'merchant'}),false);
 assert.equal(ua.calls.length,0);
 const external=visit({...opts});
 assert.equal(external.window.LineInitialEntry.enterBeforeInit({liffId:ID.merchant,scope:'merchant'}),true);
 assert.equal(new URL(external.calls[0][1]).pathname,'/'+ID.merchant);
});
test('AC-LINE-028: wrong-channel LIFF recovery is automatic once, never sends a secret, and has no global logout',()=>{
 const opts={url:'https://example.netlify.app/admin/?business=shop-a&jwt=private&bookingId=B-99',scope:'merchant',liffId:ID.merchant,business:'shop-a'};
 const h=visit(opts),recover=()=>h.window.LineInitialEntry.recover({liffId:ID.merchant,scope:'merchant',business:'shop-a'});
 assert.equal(recover(),true);
 const u=new URL(h.calls[0][1]);
 assert.equal(u.origin,'https://liff.line.me');
 assert.equal(u.pathname,'/'+ID.merchant);
 assert.equal(u.searchParams.get('business'),'shop-a');
 assert.equal(u.searchParams.get('bookingId'),'B-99');
 assert.equal(u.searchParams.has('jwt'),false);
 assert.equal(recover(),false);
 assert.equal(h.calls.length,1);
 assert.equal(h.calls.some(([name])=>name==='logout'),false);
});
test('AC-LINE-029: auto recovery does not interfere with OAuth callback or loop when storage blocked',()=>{
 for(const query of ['code=secret&state=nonce','access_token=opaque','liff.state=%3Fbusiness%3Dshop-a']){
  const h=visit({url:'https://example.netlify.app/admin/?'+query});
  assert.equal(h.window.LineInitialEntry.recover({liffId:ID.merchant,scope:'merchant'}),false);
  assert.equal(h.calls.length,0);
 }
 const blocked=visit({storageBlocked:true});
 assert.equal(blocked.window.LineInitialEntry.recover({liffId:ID.merchant,scope:'merchant'}),false);
 assert.equal(blocked.calls.length,0);
});

test('AC-LINE-030: the same tab does not restart LIFF when primary redirect changes to secondary endpoint path',()=>{
 const storage=new Map();
 const first=visit({url:'https://example.netlify.app/admin/?business=shop-a',scope:'merchant',liffId:ID.merchant,business:'shop-a',storage});
 assert.equal(first.window.LineInitialEntry.enterBeforeInit({liffId:ID.merchant,scope:'merchant',business:'shop-a'}),true);
 const callback=visit({url:'https://example.netlify.app/admin/workspace.html?business=shop-a',scope:'merchant',liffId:ID.merchant,business:'shop-a',storage});
 assert.equal(callback.window.LineInitialEntry.enterBeforeInit({liffId:ID.merchant,scope:'merchant',business:'shop-a'}),false);
 assert.equal(callback.enter(),false);
 assert.equal(callback.calls.length,0,'returning through the other endpoint path must never start a new authorization');
 const newTab=visit({url:'https://example.netlify.app/admin/workspace.html?business=shop-a',scope:'merchant',liffId:ID.merchant,business:'shop-a'});
 assert.equal(newTab.window.LineInitialEntry.enterBeforeInit({liffId:ID.merchant,scope:'merchant',business:'shop-a'}),true,'a fresh tab must still authenticate independently');
});
test('AC-LINE-031: wrong-audience recovery stays bounded even when LINE changes callback pathname',()=>{
 const storage=new Map();
 const opts={scope:'merchant',liffId:ID.merchant,business:'shop-a',storage};
 const first=visit({...opts,url:'https://example.netlify.app/admin/?business=shop-a'});
 assert.equal(first.window.LineInitialEntry.recover(opts),true);
 const callback=visit({...opts,url:'https://example.netlify.app/admin/workspace.html?business=shop-a'});
 assert.equal(callback.window.LineInitialEntry.recover(opts),false);
 assert.equal(callback.calls.length,0);
});

test('AC-LINE-034: per-tab guard remains independent for different LIFF channels and scopes',()=>{
 const storage=new Map();
 const shared={url:'https://example.netlify.app/member/?business=shop-a',business:'shop-a',storage};
 const member=visit({...shared,scope:'member',liffId:ID.member});
 assert.equal(member.window.LineInitialEntry.enterBeforeInit({liffId:ID.member,scope:'member',business:'shop-a'}),true);
 const merchant=visit({...shared,scope:'merchant',liffId:ID.merchant});
 assert.equal(merchant.window.LineInitialEntry.enterBeforeInit({liffId:ID.merchant,scope:'merchant',business:'shop-a'}),true);
 const memberReturn=visit({...shared,url:'https://example.netlify.app/member/callback/?business=shop-a',scope:'member',liffId:ID.member});
 assert.equal(memberReturn.window.LineInitialEntry.enterBeforeInit({liffId:ID.member,scope:'member',business:'shop-a'}),false);
});
