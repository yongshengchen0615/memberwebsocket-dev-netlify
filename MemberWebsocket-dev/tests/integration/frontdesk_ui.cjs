const {test}=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),fs=require('node:fs'),path=require('node:path');
const source=()=>fs.readFileSync(path.join(__dirname,'../../frontdesk/app.js'),'utf8');
for(const mode of ['notify_only','review'])test('frontdesk UI '+mode+' uses its tenant and only offers granted operations',async()=>{
 const dom=new JSDOM('<h1 id="businessName"></h1><p id="status" role="status"></p><div id="account"></div><div id="bookings"></div><button id="refresh">重新整理</button>',{url:'https://desk.test/frontdesk/?business=shop-a',runScripts:'outside-only'}),w=dom.window,calls=[];
 w.crypto.randomUUID=()=>crypto.randomUUID();w.liff={isInClient:()=>true,init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'verified',logout:()=>{},login:()=>{}};
 w.fetch=async(url,init)=>{if(!init?.body)return {ok:true,json:async()=>({supabaseFunctionUrl:'https://db.test/functions/v1/api',supabasePublishableKey:'public'})};const b=JSON.parse(init.body);calls.push(b);return{ok:true,json:async()=>({ok:true,data:b.action==='frontdesk.public'?{name:'Shop',frontdesk:{enabled:true,liffId:'2010999999-desk',oaId:'@desk'}}:b.action==='frontdesk.bootstrap'?{staff:{status:'approved',permissionMode:mode}}:{bookings:[{id:'booking-a',status:'pending',updatedAt:'v1',name:'Test',services:[]}]}})};};
 const ready=new Promise(resolve=>w.addEventListener('frontdesk-ready',resolve,{once:true}));w.eval(source());await ready;
 assert.equal(calls.every(b=>b.business==='shop-a'),true);assert.equal(calls.filter(b=>b.action==='frontdesk.bookings').length,mode==='review'?1:0);
 assert.equal(w.document.querySelectorAll('[data-review-action]').length,mode==='review'?2:0);
 assert.equal(w.document.body.textContent.includes(mode==='review'?'可確認／拒絕預約':'僅接收預約訊息'),true);w.close();
});
test('authoritative revocation clears previously rendered booking details and actions',async()=>{
 const dom=new JSDOM('<h1 id="businessName"></h1><p id="status"></p><div id="account"></div><div id="bookings"></div><button id="refresh">重新整理</button>',{url:'https://desk.test/frontdesk/?business=shop-a',runScripts:'outside-only'}),w=dom.window;let revoked=false;
 w.liff={isInClient:()=>true,init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'verified'};
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
 w.dispatchEvent(new w.CustomEvent('frontdesk:refresh',{detail:{business:'shop-a'}}));
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
 w.dispatchEvent(new w.CustomEvent('frontdesk:refresh',{detail:{business:'shop-a'}}));
 await settle();
 assert.equal(calls.length,beforeDispose,'revoked root must not retain listeners');
 dom.window.close();
});

test('frontdesk removal requires confirmation, sends scoped delete, and clears staff UI',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://desk.test/admin/frontdesk-settings/?business=shop-a',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,root=w.document.getElementById('root'),staffId='10000000-0000-4000-8000-000000000006';
 let data={version:2,frontdesk:{enabled:true,loginChannelId:'2010999999',liffId:'2010999999-desk',messagingChannelId:'2010888888'},staff:[{id:staffId,version:3,status:'approved',permissionMode:'review',displayName:'刪除測試人員'}]};
 const calls=[];let allowed=false,confirmations=0,attempts=0;w.confirm=()=>{confirmations++;return allowed;};w.crypto.randomUUID=()=>crypto.randomUUID();
 const request=async(action,body)=>{calls.push({action,body});if(action==='platform.frontdesk.get')return structuredClone(data);
  if(action==='platform.frontdesk.staff.delete'){assert.equal(body.staffId,staffId);assert.equal(body.expectedVersion,3);if(++attempts===1)throw Object.assign(Error('網路回應未知'),{uncertain:true});data={...data,staff:[]};return structuredClone(data);}
  throw Error('unexpected action '+action);};
 w.eval(fs.readFileSync(path.join(__dirname,'../../admin/frontdesk-settings.js'),'utf8'));
 w.FrontdeskSettings.mount({root,request,business:'shop-a'});
 root.querySelector('details').open=true;root.querySelector('details').dispatchEvent(new w.Event('toggle'));await new Promise(r=>setImmediate(r));
 assert.equal(root.querySelectorAll('.frontdesk-remove-staff').length,1);
 root.querySelector('.frontdesk-remove-staff').click();await new Promise(r=>setImmediate(r));
 assert.equal(calls.filter(x=>x.action==='platform.frontdesk.staff.delete').length,0,'cancelled confirmation must be inert');
 allowed=true;root.querySelector('.frontdesk-remove-staff').click();await new Promise(r=>setImmediate(r));
 const retry=root.querySelector('.frontdesk-remove-staff');
 assert.equal(calls.filter(x=>x.action==='platform.frontdesk.staff.delete').length,1);
 assert.equal(retry.disabled,false,'an uncertain removal must offer an enabled retry');
 assert.equal(retry.textContent,'重試相同儲存操作');
 assert.equal(retry.getAttribute('aria-label'),'重試相同儲存操作','screen readers must identify the retry');
 assert.equal(root.querySelector('.frontdesk-person button[type=submit]').disabled,true,'different writes stay locked');
 retry.click();await new Promise(r=>setImmediate(r));
 const deletions=calls.filter(x=>x.action==='platform.frontdesk.staff.delete');
 assert.equal(deletions.length,2,'same deletion re-sent exactly once');
 assert.deepEqual(deletions[0].body,deletions[1].body,'retry must preserve requestId, version and person');
 assert.equal(confirmations,2,'only initial cancel and initial approval should prompt');
 assert.equal(root.querySelectorAll('.frontdesk-remove-staff').length,0);
 assert.match(root.textContent,/目前沒有申請/);
 assert.match(root.textContent,/須重新申請並審核/);
 w.FrontdeskSettings.clear(root);dom.window.close();
});


test('AC-FD-UX-001: staff cards expose readable schedule, tappable phone, privacy-safe text and clear actions',async()=>{
 const dom=new JSDOM('<h1 id="businessName"></h1><p id="status" role="status"></p><ol id="progress"></ol><section id="account"></section><div class="frontdesk-toolbar"><p class="frontdesk-kicker"></p><h2>待處理預約</h2><p id="bookingSummary"></p><button id="refresh">重新整理</button></div><section id="bookings"></section>',{url:'https://desk.test/frontdesk/?business=shop-a',runScripts:'outside-only'}),w=dom.window;
 w.liff={isInClient:()=>true,init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'verified'};
 w.fetch=async(_url,options)=>{
  if(!options?.body)return{ok:true,json:async()=>({supabaseFunctionUrl:'https://db.test/functions/v1/api',supabasePublishableKey:'public'})};
  const {action}=JSON.parse(options.body);
  const data=action==='frontdesk.public'?{name:'店家',frontdesk:{enabled:true,liffId:'2010999999-desk'}}:
   action==='frontdesk.bootstrap'?{staff:{displayName:'測試櫃檯',status:'approved',permissionMode:'review'}}:
   {bookings:[{id:'booking-a',name:'<img src=x onerror=alert(1)>',status:'pending',updatedAt:'v1',startAt:'2026-11-20T10:00:00',endAt:'2026-11-20T11:00:00',phone:'+886 900 123 456',partySize:2,services:[{title:'身體按摩',quantity:2}],note:'請留意需求'}]};
  return{ok:true,json:async()=>({ok:true,data})};
 };
 const ready=new Promise(resolve=>w.addEventListener('frontdesk-ready',resolve,{once:true}));w.eval(source());await ready;
 const card=w.document.querySelector('.frontdesk-card');
 assert.ok(card);assert.match(card.textContent,/預約日期：2026-11-20/);assert.match(card.textContent,/預約時間：10:00 – 11:00/);
 assert.equal(card.querySelector('.frontdesk-badge').textContent,'待確認');
 assert.equal(card.querySelector('a[href^="tel:"]').getAttribute('href'),'tel:+886900123456');
 assert.match(card.querySelector('.frontdesk-participant').textContent,/第一位預約/);
 assert.match(card.querySelector('.frontdesk-participant').textContent,/身體按摩 × 2/);
 assert.match(card.querySelector('.frontdesk-participant').textContent,/預約技師：現場安排/);
 assert.equal(card.querySelectorAll('img').length,0,'server text must never be injected as markup');
 assert.equal(card.querySelectorAll('[data-review-action]').length,2);
 assert.equal(w.document.getElementById('progress').hidden,true,'approved staff do not need a completed application guide');
 assert.match(w.document.getElementById('bookingSummary').textContent,/1 筆/);
 w.close();
});

test('AC-FD-LINE-001: distinct participants, technicians and individual notes follow LINE message ordering',async()=>{
 const dom=new JSDOM('<h1 id="businessName"></h1><p id="status"></p><ol id="progress"></ol><section id="account"></section><div class="frontdesk-toolbar"><h2></h2><p id="bookingSummary"></p><button id="refresh"></button></div><section id="bookings"></section>',{url:'https://desk.test/frontdesk/?business=shop-a',runScripts:'outside-only'}),w=dom.window;
 w.liff={isInClient:()=>true,init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'verified'};
 w.fetch=async(_url,opts)=>{
  if(!opts?.body)return{ok:true,json:async()=>({supabaseFunctionUrl:'https://db.test/functions/v1/api',supabasePublishableKey:'public'})};
  const {action}=JSON.parse(opts.body);
  const data=action==='frontdesk.public'?{name:'店家',frontdesk:{enabled:true,liffId:'2010999999-desk'}}:
   action==='frontdesk.bootstrap'?{staff:{status:'approved',permissionMode:'review'}}:
   {bookings:[{id:'booking-a',status:'pending',updatedAt:'2026-11-20T00:00:00',bookingDate:'2026-11-20',startTime:'09:30',endTime:'10:30',name:'陳先生',phone:'+886900638213',partySize:2,adminNote:'請提前準備房間',services:[],participants:[
    {position:1,technician:'10技師',services:[{title:'身體60',quantity:1}],note:'力道較輕'},
    {position:2,technician:'11技師',services:[{title:'腳底30',quantity:1}],note:'<script>alert(1)</script>'}]}]};
  return{ok:true,json:async()=>({ok:true,data})};
 };
 const ready=new Promise(resolve=>w.addEventListener('frontdesk-ready',resolve,{once:true}));w.eval(source());await ready;
 const card=w.document.querySelector('.frontdesk-card'),blocks=card.querySelectorAll('.frontdesk-participant');
 assert.equal(blocks.length,2);
 assert.match(card.textContent,/預約日期：2026-11-20/);
 assert.match(card.textContent,/預約時間：09:30 – 10:30/);
 assert.match(card.textContent,/預約人：陳先生/);
 assert.match(card.textContent,/管理端說明：請提前準備房間/);
 assert.match(blocks[0].textContent,/第一位預約.*預約項目：身體60.*預約技師：10技師.*個別備註：力道較輕/s);
 assert.match(blocks[1].textContent,/第二位預約.*預約項目：腳底30.*預約技師：11技師/s);
 assert.equal(blocks[0].textContent.includes('腳底30'),false,'participants must not share items');
 assert.equal(card.querySelectorAll('script').length,0,'untrusted notes are text, not HTML');
 w.close();
});


test('AC-FR-MODAL-001..003: modal requires a reason; phone section appears only for walk-in and forwards original booking date indirectly',async()=>{
 const bookingId='10000000-0000-4000-8000-000000000008';
 const dom=new JSDOM('<h1 id="businessName"></h1><p id="status"></p><ol id="progress"></ol><section id="account"></section><div class="frontdesk-toolbar"><h2></h2><p id="bookingSummary"></p><button id="refresh">刷新</button></div><section id="bookings"></section>',{url:'https://desk.test/frontdesk/?business=shop-a',runScripts:'outside-only'}),w=dom.window;
 const calls=[];w.crypto.randomUUID=()=>crypto.randomUUID();
 w.liff={isInClient:()=>true,init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'verified'};
 w.fetch=async(_url,init)=>{
  if(!init?.body)return{ok:true,json:async()=>({supabaseFunctionUrl:'https://db.test/functions/v1/api',supabasePublishableKey:'public'})};
  const body=JSON.parse(init.body);calls.push(body);
  const data=body.action==='frontdesk.public'?{name:'QA',frontdesk:{enabled:true,liffId:'2010999999-desk'}}:
   body.action==='frontdesk.bootstrap'?{staff:{status:'approved',permissionMode:'review'}}:
   body.action==='frontdesk.bookings'?{bookings:[{id:bookingId,name:'QA',status:'pending',updatedAt:'2026-11-20T10:00:00.000Z',bookingDate:'2026-12-12',startTime:'11:00',endTime:'12:00',totalDurationMinutes:60,services:[]}]}:
   body.action==='frontdesk.booking.reject-phone'?{booking:{status:'rejected'},phoneBookingStatus:'confirmed'}:{};
  return{ok:true,json:async()=>({ok:true,data})};
 };
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 const ready=new Promise(resolve=>w.addEventListener('frontdesk-ready',resolve,{once:true}));w.eval(source());await ready;
 assert.equal(w.document.querySelector('[data-frontdesk-rejection-dialog]'),null);
 assert.equal(w.document.querySelector('#account [data-phone-registration]'),null);
 const reject=[...w.document.querySelectorAll('[data-review-action]')].find(b=>b.textContent==='拒絕預約');assert.ok(reject);reject.click();
 assert.ok(w.document.querySelector('[role=dialog]'));
 w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 assert.equal(w.document.querySelector('[role=dialog]'),null,'Escape closes without a rejection request');
 assert.equal(calls.filter(b=>b.action==='frontdesk.booking.update'||b.action==='frontdesk.booking.reject-phone').length,0);
 reject.click();
 const dialog=w.document.querySelector('[role=dialog]'),reason=dialog.querySelector('select[aria-label="選擇拒絕預約原因"]'),panel=dialog.querySelector('[data-phone-registration]');
 assert.ok(dialog);assert.equal(panel.hidden,true);assert.equal(dialog.querySelector('button[type=submit]').disabled,true);
 assert.equal(calls.filter(b=>b.action==='frontdesk.phone.catalog').length,0);
 reason.value='technician_leave';reason.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(panel.hidden,true);assert.equal(dialog.querySelector('button[type=submit]').disabled,false);
 assert.equal(calls.filter(b=>b.action==='frontdesk.phone.catalog').length,0);
 reason.value='unrecorded_phone_booking';reason.dispatchEvent(new w.Event('change',{bubbles:true}));await settle();
 assert.equal(panel.hidden,false);assert.match(panel.textContent,/2026-12-12/);
  assert.match(panel.textContent,/無須等待管理員審核/);
 assert.equal(dialog.querySelectorAll('.frontdesk-phone-service-option').length,0);
 const duration=dialog.querySelector('select[aria-label="衝突預約總時長"]');
 assert.ok(duration);assert.equal(duration.value,'60');
 assert.equal([...duration.options].some(o=>o.value==='0'),false,'invalid durations are not selectable');
 assert.equal([...duration.options].every(o=>Number(o.value)%10===0),true);
 duration.value='90';duration.dispatchEvent(new w.Event('change',{bubbles:true}));
 const time=dialog.querySelector('select[aria-label="衝突預約時間"]');
 assert.ok(time);assert.equal(time.value,'11:00');
 assert.equal([...time.options].every(o=>Number(o.value.slice(-2))%10===0),true);
 assert.match(dialog.querySelector('.frontdesk-original-booking').textContent,/原預約總時長：60 分鐘/);
 assert.equal(dialog.querySelector('button[type=submit]').disabled,false);
 dialog.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();await settle();
 const req=calls.find(b=>b.action==='frontdesk.booking.reject-phone');assert.ok(req);
 assert.equal(req.bookingId,bookingId);assert.equal(req.startTime,'11:00');
 assert.equal(req.rejectionReason,'unrecorded_phone_booking');
 assert.equal(req.totalDurationMinutes,90);assert.equal(Object.hasOwn(req,'items'),false);
 assert.equal(Object.hasOwn(req,'bookingDate'),false);
 assert.equal(Object.hasOwn(req,'contactSurname'),false);
 assert.match(req.requestId,/^[0-9a-f-]{36}$/i);assert.match(req.phoneRequestId,/^PHONE-[0-9a-f-]{36}$/i);
 assert.equal(calls.filter(x=>x.action==='frontdesk.phone.create').length,0);
  assert.match(w.document.getElementById('status').textContent,/電話／現場預約已登記並直接確認/);
  assert.doesNotMatch(w.document.getElementById('status').textContent,/等待管理員確認/);
 w.close();
});
test('AC-FR-MODAL-004: technician leave requires reason and never requests phone catalog or replacement',async()=>{
 const dom=new JSDOM('<h1 id="businessName"></h1><p id="status"></p><ol id="progress"></ol><section id="account"></section><div class="frontdesk-toolbar"><h2></h2><p id="bookingSummary"></p><button id="refresh">刷新</button></div><section id="bookings"></section>',{url:'https://desk.test/frontdesk/?business=shop-a',runScripts:'outside-only'}),w=dom.window;
 const calls=[];w.crypto.randomUUID=()=>crypto.randomUUID();w.liff={isInClient:()=>true,init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'verified'};
 w.fetch=async(_url,init)=>{
  if(!init?.body)return{ok:true,json:async()=>({supabaseFunctionUrl:'https://db.test/functions/v1/api',supabasePublishableKey:'public'})};
  const body=JSON.parse(init.body);calls.push(body);
  const data=body.action==='frontdesk.public'?{name:'QA',frontdesk:{enabled:true,liffId:'2010999999-desk'}}:
   body.action==='frontdesk.bootstrap'?{staff:{status:'approved',permissionMode:'review'}}:
   body.action==='frontdesk.bookings'?{bookings:[{id:'10000000-0000-4000-8000-000000000008',status:'pending',updatedAt:'2026-11-20T10:00:00.000Z',services:[]}]}:{};
  return{ok:true,json:async()=>({ok:true,data})};
 };
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 const ready=new Promise(resolve=>w.addEventListener('frontdesk-ready',resolve,{once:true}));w.eval(source());await ready;
 [...w.document.querySelectorAll('[data-review-action]')].find(b=>b.textContent==='拒絕預約').click();
 const dialog=w.document.querySelector('[role=dialog]'),reason=dialog.querySelector('select');
 assert.equal(dialog.querySelector('button[type=submit]').disabled,true);
 assert.equal(calls.filter(b=>b.action==='frontdesk.booking.update').length,0);
 reason.value='technician_leave';reason.dispatchEvent(new w.Event('change',{bubbles:true}));
 dialog.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();await settle();
 const update=calls.find(b=>b.action==='frontdesk.booking.update');
 assert.ok(update);assert.equal(update.rejectionReason,'technician_leave');assert.equal(update.status,'rejected');
 assert.equal(calls.filter(b=>b.action==='frontdesk.phone.catalog'||b.action==='frontdesk.booking.reject-phone').length,0);
 w.close();
});

test('AC-FD-HIST-001~004: three accessible tabs show scoped confirmed/rejected details without HTML injection', async()=>{
 const dom=new JSDOM('<div id="root"></div>',{
  url:'https://desk.test/admin/frontdesk-settings/?business=shop-a',
  runScripts:'outside-only',pretendToBeVisual:true
 });
 const w=dom.window,root=w.document.getElementById('root'),calls=[];
 const current={version:1,frontdesk:{enabled:true,loginChannelId:'2010999999',
  liffId:'2010999999-desk',messagingChannelId:'2010888888'},staff:[]};
 const booked={bookingDate:'2026-11-20',startTime:'09:30',endTime:'10:30',
  name:'<img src=x onerror=alert(1)>',phone:'+886900000000',partySize:1,
  participants:[{position:1,technician:'10技師',note:'個別備註',
   services:[{title:'身體60',quantity:1}]}]};
 const request=async(action,body={})=>{
  calls.push({action,body});
  if(action==='platform.frontdesk.get')return structuredClone(current);
  if(action==='platform.frontdesk.history.list'){
   assert.ok(['confirmed','rejected'].includes(body.status));
   const rejected=body.status==='rejected';
   return {status:body.status,items:[{
    eventId:rejected?2:1,bookingId:'10000000-0000-4000-8000-000000000003',
    actionAt:'2026-11-20T01:30:00Z',actorName:'收件櫃檯',
    currentStatus:rejected?'cancelled':'confirmed',
    rejectionReason:rejected?'unrecorded_phone_booking':null,
    booking:booked,phoneBooking:rejected?{...booked,name:'櫃檯人員',startTime:'10:30'}:null
   }]};
  }
  throw Error('unexpected '+action);
 };
 w.eval(fs.readFileSync(path.join(__dirname,'../../admin/frontdesk-settings.js'),'utf8'));
 w.FrontdeskSettings.mount({root,request,business:'shop-a'});
 const details=root.querySelector('details');
 details.open=true;details.dispatchEvent(new w.Event('toggle'));
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 await settle();await settle();
 const tabs=[...root.querySelectorAll('[role="tab"]')];
 assert.deepEqual(tabs.map(x=>x.textContent),['LINE 設定','確認預約','拒絕預約']);
 assert.equal(tabs[0].getAttribute('aria-selected'),'true');
 assert.equal(calls.filter(x=>x.action==='platform.frontdesk.history.list').length,0,'history fetch is lazy');
 tabs[1].click();await settle();await settle();
 assert.equal(tabs[1].getAttribute('aria-selected'),'true');
 assert.equal(root.querySelector('#frontdesk-line-panel').hidden,true);
 assert.equal(root.querySelector('#frontdesk-history-panel').hidden,false);
 assert.match(root.querySelector('#frontdesk-history-panel').textContent,/收件櫃檯/);
 assert.match(root.querySelector('#frontdesk-history-panel').textContent,/身體60/);
 assert.match(root.querySelector('#frontdesk-history-panel').textContent,/個別備註/);
 assert.equal(root.querySelectorAll('img').length,0,'user-provided text must not become HTML');
 tabs[2].click();await settle();await settle();
 const history=root.querySelector('#frontdesk-history-panel');
 assert.match(history.textContent,/該時段已被現場人員預約但未登記/);
 assert.match(history.textContent,/後續登記的現場／電話預約/);
 assert.match(history.textContent,/目前狀態：已取消/);
 assert.equal(calls.filter(x=>x.action==='platform.frontdesk.history.list').length,2);
 assert.deepEqual(calls.filter(x=>x.action==='platform.frontdesk.history.list').map(x=>x.body.status),['confirmed','rejected']);
 tabs[0].click();
 assert.equal(root.querySelector('#frontdesk-history-panel').hidden,true);
 assert.equal(root.querySelector('#frontdesk-line-panel').hidden,false);
 assert.match(root.textContent,/櫃檯人員申請與權限/);
 w.FrontdeskSettings.clear(root);
 assert.equal(root.querySelectorAll('.frontdesk-history-card').length,0);
 dom.window.close();
});

test('AC-FD-HIST-005: late history responses cannot overwrite another selected tab',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{
  url:'https://desk.test/admin/frontdesk-settings/?business=shop-a',
  runScripts:'outside-only',pretendToBeVisual:true
 });
 const w=dom.window,root=w.document.getElementById('root');
 let resolveFirst;
 const request=(action,body={})=>{
  if(action==='platform.frontdesk.get')return Promise.resolve({version:1,frontdesk:{enabled:true},staff:[]});
  if(action==='platform.frontdesk.history.list'&&body.status==='confirmed')
   return new Promise(resolve=>{resolveFirst=resolve;});
  if(action==='platform.frontdesk.history.list'&&body.status==='rejected')
   return Promise.resolve({items:[]});
  throw Error(action);
 };
 w.eval(fs.readFileSync(path.join(__dirname,'../../admin/frontdesk-settings.js'),'utf8'));
 w.FrontdeskSettings.mount({root,request,business:'shop-a'});
 const details=root.querySelector('details');details.open=true;details.dispatchEvent(new w.Event('toggle'));
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 await settle();await settle();
 root.querySelector('#frontdesk-tab-confirmed').click();
 assert.equal(typeof resolveFirst,'function');
 root.querySelector('#frontdesk-tab-rejected').click();
 await settle();
 resolveFirst({items:[{bookingId:'stale-id',booking:{name:'不應顯示'}}]});
 await settle();
 assert.match(root.querySelector('#frontdesk-history-panel').textContent,/尚無櫃檯拒絕預約紀錄/);
 assert.doesNotMatch(root.textContent,/不應顯示/);
 w.FrontdeskSettings.clear(root);dom.window.close();
});

test('AC-FD-CONFLICT-SEC: revocation during history refresh purges member details immediately',async()=>{
 const html='<h1 id="businessName"></h1><p id="status" role="status"></p><ol id="progress"></ol><section id="account"></section>'+
  '<div class="frontdesk-toolbar"><p class="frontdesk-kicker"></p><h2></h2><p id="bookingSummary"></p><button id="refresh"></button></div>'+
  '<section id="bookings"></section><section id="frontdeskConflictHistory" hidden><button id="frontdeskHistoryRefresh">查看／更新紀錄</button>'+
  '<p data-frontdesk-history-status></p><div data-frontdesk-history-items></div></section>';
 const dom=new JSDOM(html,{url:'https://desk.test/frontdesk/?business=shop-a',runScripts:'outside-only'}),w=dom.window;
 let allow=true;
 w.liff={isInClient:()=>true,init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'verified'};
 w.fetch=async(_url,init)=>{
  if(!init?.body)return{ok:true,json:async()=>({supabaseFunctionUrl:'https://db.test/functions/v1/api',supabasePublishableKey:'public'})};
  const b=JSON.parse(init.body);
  if(b.action==='frontdesk.history'&&!allow)
   return{ok:false,status:403,json:async()=>({ok:false,error:{code:'FRONTDESK_REVIEW_REQUIRED',message:'你沒有預約審核權限。'}})};
  const data=b.action==='frontdesk.public'?{name:'店',frontdesk:{enabled:true,liffId:'2010999999-desk'}}:
   b.action==='frontdesk.bootstrap'?{staff:{status:'approved',permissionMode:'review'}}:
   b.action==='frontdesk.bookings'?{bookings:[]}:
   b.action==='frontdesk.history'?{items:[{actionAt:'2026-11-21T09:00:00Z',booking:{status:'rejected',bookingDate:'2026-11-21',
    startTime:'11:00',endTime:'12:00',totalDurationMinutes:60,name:'私密會員資料',phone:'0900888777'},phoneBooking:{status:'confirmed',
    bookingDate:'2026-11-21',startTime:'11:00',endTime:'12:30',totalDurationMinutes:90}}]}:{revision:'1'};
  return{ok:true,json:async()=>({ok:true,data})};
 };
 try {
 const ready=new Promise(resolve=>w.addEventListener('frontdesk-ready',resolve,{once:true}));w.eval(source());await ready;
 const button=w.document.getElementById('frontdeskHistoryRefresh'),items=w.document.querySelector('[data-frontdesk-history-items]');
 button.click();await new Promise(resolve=>setImmediate(resolve));
 assert.match(items.textContent,/私密會員資料/);
 w.document.getElementById('refresh').click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.match(items.textContent,/私密會員資料/,'authorized booking refresh must retain paired history');
 allow=false;button.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(items.textContent,'');
 assert.equal(w.document.getElementById('frontdeskConflictHistory').hidden,true);
 assert.match(w.document.getElementById('status').textContent,/沒有預約審核權限/);
 } finally {w.close();}
});
