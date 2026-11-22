const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const read = file => fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');
const migration = read('supabase/migrations/20261122183000_admin_rejection_frontdesk_line_scope.sql');
const frontend = read('frontdesk/app.js');

test('AC-ADM-FD-001: admin paired suppression is audit-proven, tenant-scoped and leaves member/frontdesk-admin routes intact',()=>{
 assert.match(migration,/create or replace function platform_private\.admin_paired_walkin_source/);
 assert.match(migration,/runtime_schema=p_schema/);
 assert.match(migration,/rejected\.action='BOOKING_REJECTED'/);
 assert.match(migration,/rejected\.actor_role='admin'/);
 assert.match(migration,/replacement\.action='BOOKING_PHONE_CREATED'/);
 assert.match(migration,/replacement\.actor_role='admin'/);
 assert.match(migration,/replacement\.actor_line_user_id=rejected\.actor_line_user_id/);
 assert.match(migration,/replacement\.created_at=rejected\.created_at/);
 assert.match(migration,/original\.rejected_at=rejected\.created_at/);
 assert.match(migration,/rejection_reason='unrecorded_phone_booking'/);
 assert.match(migration,/platform_private\.frontdesk_paired_phone_source\(TG_TABLE_SCHEMA,to_jsonb\(NEW\)\)/);
 assert.match(migration,/or platform_private\.admin_paired_walkin_source\(TG_TABLE_SCHEMA,to_jsonb\(NEW\)\)/);
 assert.match(migration,/business_templates/);
 assert.match(migration,/ADMIN_WALKIN_FRONTDESK_NOTICE_SUPPRESSED/);
 assert.match(migration,/o\.attempt_count=0 and o\.first_attempt_at is null/);
 assert.doesNotMatch(migration,/delete\s+from\s+.*notice_outbox/i);
 assert.doesNotMatch(migration,/grant execute on function platform_private\.admin_paired_walkin_source.*to (?:anon|authenticated)/is);
});

test('AC-ADM-FD-002: admin history is single-booking only; staff-wide history stays actor-bound, paired audits match',()=>{
 assert.match(migration,/actor_role=''admin'' and \$3::uuid is not null/);
 assert.match(migration,/actor_role=''frontdesk'' and actor_line_user_id=\$2/);
 assert.match(migration,/and \(\$3::uuid/);
 assert.match(migration,/paired\.actor_role=e\.actor_role/);
 assert.match(migration,/b\.rejected_by=e\.actor_line_user_id/);
 assert.match(migration,/b\.rejection_reason=''unrecorded_phone_booking''/);
 assert.match(migration,/''actorRole'',e\.actor_role/);
 assert.match(read('supabase/migrations/20261122133000_frontdesk_history_booking_scope.sql'),/and paired\.actor_line_user_id=e\.actor_line_user_id/);
 assert.match(frontend,/const visible=bookingId\?records\.filter/);
 assert.match(frontend,/if\(bookingId&&!historyLoaded\)\{historyLoaded=true;void loadConflictHistory\(\);\}/);
 assert.match(frontend,/historyLoaded=false;clearPrivateHistory\(\)/);
});

test('AC-ADM-FD-003/004: LINE deep link auto-displays admin original/replacement, excludes other orders and protects contact details',async()=>{
 const bookingId='10000000-0000-4000-8000-000000000022';
 const otherId='10000000-0000-4000-8000-000000000023';
 const html='<h1 id="businessName"></h1><p id="status"></p><ol id="progress"></ol>'+
  '<section id="account"></section><div class="frontdesk-toolbar"><h2></h2><p id="bookingSummary"></p>'+
  '<button id="refresh">刷新</button></div><section id="bookings"></section>'+
  '<section id="frontdeskConflictHistory" hidden><h2 id="frontdeskHistoryHeading"></h2>'+
  '<button id="frontdeskHistoryRefresh">查看／更新紀錄</button><p data-frontdesk-history-status></p>'+
  '<div data-frontdesk-history-items></div></section>';
 const dom=new JSDOM(html,{url:'https://desk.test/frontdesk/?business=shop-a&bookingId='+bookingId,runScripts:'outside-only'});
 const w=dom.window,calls=[];
 w.liff={isInClient:()=>true,init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>'verified'};
 w.fetch=async(_url,init)=>{
  if(!init?.body)return{ok:true,json:async()=>({supabaseFunctionUrl:'https://db.test/functions/v1/api',supabasePublishableKey:'public'})};
  const body=JSON.parse(init.body);calls.push(body);
  let data;
  if(body.action==='frontdesk.public')data={name:'店',frontdesk:{enabled:true,liffId:'2010999999-desk'}};
  else if(body.action==='frontdesk.bootstrap')data={staff:{status:'approved',permissionMode:'review'}};
  else if(body.action==='frontdesk.bookings')data={bookings:[]};
  else if(body.action==='frontdesk.sync.status')data={revision:'1'};
  else if(body.action==='frontdesk.history')data={items:[
   {actionAt:'2026-11-22T09:00:00Z',actorRole:'admin',
    booking:{id:bookingId,status:'rejected',bookingDate:'2026-12-12',startTime:'09:00',endTime:'10:10',totalDurationMinutes:70,name:'甲先生',phone:'0900111222',partySize:1},
    phoneBooking:{id:'10000000-0000-4000-8000-000000000024',status:'confirmed',bookingDate:'2026-12-12',startTime:'10:10',endTime:'11:40',totalDurationMinutes:90}},
   {actionAt:'2026-11-22T09:01:00Z',actorRole:'admin',
    booking:{id:otherId,status:'rejected',name:'不相關會員',phone:'0900999888'},
    phoneBooking:{id:'10000000-0000-4000-8000-000000000025',status:'confirmed',totalDurationMinutes:60}}
  ]};
  else throw Error('Unexpected action: '+body.action);
  return{ok:true,json:async()=>({ok:true,data})};
 };
 try{
  const ready=new Promise(resolve=>w.addEventListener('frontdesk-ready',resolve,{once:true}));
  w.eval(frontend);await ready;await new Promise(resolve=>setImmediate(resolve));
  const historyCalls=calls.filter(x=>x.action==='frontdesk.history');
  assert.equal(historyCalls.length,1,'scoped link must load once without a refresh tap');
  assert.equal(historyCalls[0].bookingId,bookingId,'query must remain scoped in SQL request');
  const panel=w.document.getElementById('frontdeskConflictHistory');
  assert.equal(panel.hidden,false);
  assert.equal(panel.querySelectorAll('.frontdesk-history-pair').length,1);
  const visible=panel.textContent;
  assert.match(visible,/管理端拒絕預約/);
  assert.match(visible,/原預約資料/);
  assert.match(visible,/管理端修改後的預約資料/);
  assert.match(visible,/預約來源：管理端/);
  assert.match(visible,/09:00 – 10:10/);
  assert.match(visible,/10:10 – 11:40/);
  assert.match(visible,/總時長：90 分鐘/);
  assert.match(visible,/0900111222/);
  assert.doesNotMatch(visible,/不相關會員|0900999888/);
  assert.doesNotMatch(visible,/預約來源：櫃檯人員/);
 }finally{w.close();}
});
