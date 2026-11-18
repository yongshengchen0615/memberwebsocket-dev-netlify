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
