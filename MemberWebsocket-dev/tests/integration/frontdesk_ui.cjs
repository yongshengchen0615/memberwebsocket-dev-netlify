const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
const source=()=>fs.readFileSync(path.join(__dirname,'../../frontdesk/app.js'),'utf8');
for(const mode of ['notify_only','review'])test('frontdesk UI '+mode+' uses its tenant and only offers granted operations',async()=>{
 const dom=new JSDOM('<h1 id="businessName"></h1><p id="status" role="status"></p><div id="account"></div><div id="bookings"></div><button id="refresh">重新整理</button>',{url:'https://desk.test/frontdesk/?business=shop-a',runScripts:'outside-only'}),w=dom.window,calls=[];
 w.crypto.randomUUID=()=>crypto.randomUUID();w.liff={init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'verified',logout:()=>{},login:()=>{}};
 w.fetch=async(url,init)=>{if(!init?.body)return {ok:true,json:async()=>({supabaseFunctionUrl:'https://db.test/functions/v1/api',supabasePublishableKey:'public'})};const b=JSON.parse(init.body);calls.push(b);return{ok:true,json:async()=>({ok:true,data:b.action==='frontdesk.public'?{name:'Shop',frontdesk:{enabled:true,liffId:'2010999999-desk',oaId:'@desk'}}:b.action==='frontdesk.bootstrap'?{staff:{status:'approved',permissionMode:mode}}:{bookings:[{id:'booking-a',status:'pending',updatedAt:'v1',name:'Test',services:[]}]}})};};
 const ready=new Promise(resolve=>w.addEventListener('frontdesk-ready',resolve,{once:true}));w.eval(source());await ready;
 assert.equal(calls.every(b=>b.business==='shop-a'),true);assert.equal(calls.filter(b=>b.action==='frontdesk.bookings').length,mode==='review'?1:0);
 assert.equal(w.document.querySelectorAll('[data-review-action]').length,mode==='review'?2:0);
 assert.equal(w.document.body.textContent.includes(mode==='review'?'可確認／拒絕預約':'僅接收預約訊息'),true);w.close();
});
test('authoritative revocation clears previously rendered booking details and actions',async()=>{
 const dom=new JSDOM('<h1 id="businessName"></h1><p id="status"></p><div id="account"></div><div id="bookings"></div><button id="refresh">重新整理</button>',{url:'https://desk.test/frontdesk/?business=shop-a',runScripts:'outside-only'}),w=dom.window;let revoked=false;
 w.liff={init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'verified'};
 w.fetch=async(_url,init)=>{if(!init?.body)return{ok:true,json:async()=>({supabaseFunctionUrl:'https://db.test/functions/v1/api',supabasePublishableKey:'public'})};const b=JSON.parse(init.body);if(revoked&&b.action==='frontdesk.bootstrap')return{ok:false,status:403,json:async()=>({ok:false,error:{code:'FRONTDESK_UNAVAILABLE',message:'櫃檯已停用'}})};return{ok:true,json:async()=>({ok:true,data:b.action==='frontdesk.public'?{name:'Shop',frontdesk:{enabled:true,liffId:'2010999999-desk'}}:b.action==='frontdesk.bootstrap'?{staff:{status:'approved',permissionMode:'review'}}:{bookings:[{id:'a',status:'pending',name:'Private name',phone:'Private phone',updatedAt:'v1',services:[]}]}})};};
 const ready=new Promise(r=>w.addEventListener('frontdesk-ready',r,{once:true}));w.eval(source());await ready;assert.ok(w.document.getElementById('bookings').textContent.includes('Private phone'));
 revoked=true;const failed=new Promise(resolve=>{const observer=new w.MutationObserver(()=>{if(w.document.getElementById('status').textContent.includes('停用')){observer.disconnect();resolve();}});observer.observe(w.document.getElementById('status'),{childList:true,subtree:true});});w.document.getElementById('refresh').click();await failed;
 assert.equal(w.document.getElementById('bookings').textContent,'');assert.equal(w.document.querySelectorAll('[data-review-action]').length,0);w.close();
});

test('merchant frontdesk settings reconcile server changes without overwriting drafts',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://desk.test/admin/?business=shop-a',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,root=w.document.getElementById('root'),calls=[];
 let current={version:1,frontdesk:{enabled:true,liffId:'2010999999-desk',loginChannelId:'2010999999',messagingChannelId:'2010888888'},staff:[]};
 const request=async action=>{
   calls.push(action);
   assert.equal(action,'platform.frontdesk.get');
   return structuredClone(current);
 };
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 w.eval(fs.readFileSync(path.join(__dirname,'../../admin/frontdesk-settings.js'),'utf8'));
 w.FrontdeskSettings.mount({root,request,business:'shop-a'});
 const details=root.querySelector('details');
 details.open=true;
 details.dispatchEvent(new w.Event('toggle'));
 await settle();
 assert.ok(calls.length>=1);
 assert.match(root.textContent,/櫃檯已設定 LINE 入口/);
 const afterInitial=calls.length;
 current={...current,version:2,staff:[{id:'staff-1',version:1,status:'pending',displayName:'收件櫃檯',permissionMode:'notify_only'}]};
 w.dispatchEvent(new w.CustomEvent('frontdesk:refresh',{detail:{business:'other-shop'}}));
 await settle();
 assert.equal(calls.length,afterInitial,'other merchant cannot trigger an update');
 w.dispatchEvent(new w.CustomEvent('frontdesk:refresh',{detail:{business:'shop-a'}}));
 await settle();
 assert.ok(calls.length>afterInitial);
 assert.match(root.textContent,/收件櫃檯/);
 const field=root.querySelector('input[name="messagingChannelId"]');
 field.value='2010777777';
 field.dispatchEvent(new w.Event('input',{bubbles:true}));
 // The server returns the same version after an explicit discard, but the
 // abandoned form must still be rebuilt from authoritative saved values.
 w.confirm=()=>true;
 const beforeSameVersion=calls.length;
 root.querySelector('button.button-outline').click();
 await settle();
 assert.ok(calls.length>beforeSameVersion);
 assert.equal(root.querySelector('input[name="messagingChannelId"]').value,'2010888888',
   'force reload must discard same-version unsaved values');
 const secondDraft=root.querySelector('input[name="messagingChannelId"]');
 secondDraft.value='2010777777';
 secondDraft.dispatchEvent(new w.Event('input',{bubbles:true}));
 const beforeDirtyRefresh=calls.length;
 current={...current,version:3,staff:[]};
 w.dispatchEvent(new w.Event('focus'));
 await settle();
 assert.equal(calls.length,beforeDirtyRefresh,'the draft must survive background invalidation');
 assert.equal(secondDraft.value,'2010777777');
 w.confirm=()=>true;
 root.querySelector('button.button-outline').click();
 await settle();
 assert.ok(calls.length>beforeDirtyRefresh);
 assert.equal(root.textContent.includes('收件櫃檯'),false);
 w.FrontdeskSettings.clear(root);
 const beforeDispose=calls.length;
 w.dispatchEvent(new w.Event('focus'));
 await settle();
 assert.equal(calls.length,beforeDispose,'revoked root must not retain listeners');
 dom.window.close();
});
