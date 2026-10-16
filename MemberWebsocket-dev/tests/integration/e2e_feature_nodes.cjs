const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root = path.join(__dirname,'../..');
const read = relative => fs.readFileSync(path.join(root,relative),'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve,25));

function userProbe(w) {
  w.eval(read('user-test-control.js').replace('  window.MemberUserTestControl =',
    '  window.nodeProbe={state,buttonCoverageCase,verifyBookingCancellation,bookingReceiptReviewContractCase,memberPhoneCountryValidationCase,bookingAccessibleModeCase,bookingAccessibleReceiptBoundaryCase,bookingTicketRulesCase,bookingHistoryTicketSourcesCase,eventTodayUsableLimitCase,pointSettingsCase};\n  window.MemberUserTestControl ='));
  w.nodeProbe.state.config={supabaseUrl:'https://fixture.supabase.co'};
  return w.nodeProbe;
}
function dom(surface) { return new JSDOM(read(surface+'/index.html'),{url:'https://example.test/MemberWebsocket-dev/'+surface+'/',runScripts:'outside-only',pretendToBeVisual:true}); }

test('phone node executes the production normalizer and catches a backend that accepts repetition',async()=>{
  const d=dom('member'),w=d.window;
  try {
    w.eval(read('member/member-phone.js'));
    let calls=0;
    w.MemberSystem={request:async(_config,_type,_token,action,payload)=>{
      calls++;assert.equal(action,'user.member.profile.save');assert.equal(payload.phone,'+886111111111');
      throw Object.assign(new Error('Invalid phone'),{code:'INVALID_PHONE'});
    }};
    const node=userProbe(w);
    assert.equal((await node.memberPhoneCountryValidationCase()).status,'passed');
    assert.equal(calls,1);
    w.MemberSystem.request=async()=>({});
    assert.equal((await node.memberPhoneCountryValidationCase()).status,'failed');
  }finally{w.close();}
});

test('accessible node drives production mode UI and restores each member preference',async()=>{
  const preferenceKey='booking-mode:v2:test:feature-node';
  for(const preference of [null,'general','accessible']) {
    const d=dom('booking'),w=d.window;
    try {
      if(preference!==null)w.localStorage.setItem(preferenceKey,preference);
      const items=[{kind:'points',selectable:true,title:'QA card'}, {kind:'event',selectable:true,title:'QA event'}, {kind:'points',selectable:true,reservedForBooking:true}, {kind:'points',selectable:false,reservedForBooking:true}];
      let cameraCalls=0;
      w.BookingBenefits={getItems:()=>items,syncNow:()=>{w.document.getElementById('bookingBenefits').dataset.state='ready';w.document.getElementById('bookingBenefitsList').setAttribute('aria-busy','false');w.dispatchEvent(new w.CustomEvent('booking:benefits-loaded',{detail:{items}}));}};
      w.BookingReceipts={openAccessible:()=>cameraCalls++,refresh:async()=>w.dispatchEvent(new w.CustomEvent('booking:receipts-updated',{detail:{submissions:[]}}))};
      w.BookingSystem={request:async()=>({submissions:[]})};
      w.eval(read('ui-components.js'));w.eval(read('booking/booking-accessible.js'));await tick();
      w.dispatchEvent(new w.CustomEvent('booking:member-loaded',{detail:{profile:{lineUserId:'test:feature-node'}}}));
      const node=userProbe(w);
      const result=await node.bookingAccessibleModeCase();
      assert.equal(result.status,'passed',JSON.stringify(result));
      assert.equal(w.localStorage.getItem(preferenceKey),preference);
      assert.equal(cameraCalls,0);
      assert.equal(w.document.getElementById('bookingAccessibleToggle').getAttribute('aria-pressed'),String(preference==='accessible'));
    }finally{w.close();}
  }
});

test('accessible receipt boundary node detects unexpected acceptance and never sends valid prepare',async()=>{
  const d=dom('booking'),w=d.window;
  try {
    const payloads=[];
    w.BookingSystem={request:async(_config,type,_token,action,payload)=>{
      assert.equal(type,'booking');assert.equal(action,'user.booking.receipt.prepare');payloads.push(payload);
      throw Object.assign(new Error('Invalid image'),{code:payload.mimeType==='text/plain'?'RECEIPT_INVALID_MIME':'RECEIPT_FILE_TOO_LARGE'});
    }};
    const node=userProbe(w);
    assert.equal((await node.bookingAccessibleReceiptBoundaryCase()).status,'passed');
    assert.equal(payloads.length,3);assert.ok(payloads.every(item=>item.accessible));
    w.BookingSystem.request=async()=>({uploadToken:'unexpected'});
    assert.equal((await node.bookingAccessibleReceiptBoundaryCase()).status,'failed');
  }finally{w.close();}
});

test('ticket rule node tests real any/all selection rejection without claiming an event',async()=>{
  const d=dom('booking'),w=d.window;
  try {
    let claims=0;
    const items=[
      {kind:'points',id:'PT',selectionId:'PT',selectable:true,cardId:'CARD',pointCost:2,pointBalance:10,requiredServiceIds:['BODY'],requiredServiceMatchMode:'any',title:'QA points'},
      {kind:'event',id:'EV',selectionId:'',selectable:true,claimRequired:true,requiredServiceIds:['BODY','FACE'],requiredServiceMatchMode:'all',title:'QA event'}
    ];
    w.BookingSystem={bookingBenefits:async()=>({items,eventTicketMaxPerDay:0,pointTicketMaxPerRedemption:0}),claimEventTicket:async()=>{claims++;return{};}};
    w.eval(read('ui-components.js'));w.eval(read('booking/booking-benefits.js'));w.BookingBenefits.start({},'fixture');await tick();
    const node=userProbe(w),result=await node.bookingTicketRulesCase();
    assert.equal(result.status,'passed',JSON.stringify(result));
    assert.equal(result.actual.serviceChecks.length,2);assert.equal(claims,0);
    w.BookingSystem.bookingBenefits=async()=>({items:[]});
    assert.equal((await node.bookingTicketRulesCase()).status,'skipped','missing data must be blocked, not pass');
  }finally{w.close();}
});

test('booking history sources node uses member bootstrap and checks production ticket cards',async()=>{
  const d=dom('booking'),w=d.window;
  try {
    w.BookingSystem={request:async(_config,type,_token,action)=>{
      assert.equal(type,'member');assert.equal(action,'user.booking.bootstrap');
      return {bookings:[{bookingId:'QA-HISTORY',benefits:[{kind:'points',title:'QA card｜QA ticket',status:'pending'}]}]};
    }};
    w.document.getElementById('bookingList').innerHTML='<article data-booking-id="QA-HISTORY"><article class="booking-ticket-card kind-points"><div class="booking-ticket-source">QA card</div><strong>QA ticket</strong></article></article>';
    const node=userProbe(w);assert.equal((await node.bookingHistoryTicketSourcesCase()).status,'passed');
    w.document.querySelector('.booking-ticket-source').textContent='Wrong card';assert.equal((await node.bookingHistoryTicketSourcesCase()).status,'failed');
  }finally{w.close();}
});

test('all surfaces classify actual tour controls while unknown buttons still fail',async()=>{
  for(const surface of ['member','points','event','calendar','booking']) {
    const d=dom(surface),w=d.window;
    try {
      w.document.body.replaceChildren();
      for(const id of ['openMemberTour','memberTourSkip','memberTourBack','memberTourNext',...(surface==='member'?['renewTermsButton']:[])]) {
        const button=w.document.createElement('button');button.id=id;w.document.body.append(button);
      }
      const node=userProbe(w);assert.equal((await node.buttonCoverageCase()).status,'passed',surface);
      const unknown=w.document.createElement('button');unknown.id='unregisteredFeature';w.document.body.append(unknown);
      assert.equal((await node.buttonCoverageCase()).status,'failed',surface);
    }finally{w.close();}
  }
});

test('event quota node accepts zero and verifies the current used-count copy and datasets',async()=>{
  for(const limit of [0,1,2]) {
    const d=dom('event'),w=d.window;
    try {
      const data={usedTodayCount:limit===0?3:0,availableTodayCount:4,remainingTodayCount:limit||4,todayUsableCount:limit||4,maxTicketsPerDay:limit};
      const config={supabaseUrl:'https://fixture.supabase.co'};
      w.MemberSystem={getSession:()=>({config,idToken:'fixture'})};
      w.TestModeClient={getSessionToken:()=>''};
      w.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true,data})});
      w.eval(read('event/today-usable.js'));w.dispatchEvent(new w.Event('focus'));await tick();
      const node=userProbe(w),result=await node.eventTodayUsableLimitCase();await tick();
      assert.equal(result.status,'passed',JSON.stringify(result));
      assert.ok(result.actual.text.includes(limit===0?'不限張數':limit+' 張'));
    }finally{w.close();}
  }
});

function adminProbe(w) {
  w.eval(read('admin/e2e-control.js').replace('  window.MemberAdminE2EControl =',
    '  window.nodeProbe={state,adminAutomationHealthCase,adminTierSettingsCase,adminBirthdaySettingsCase,adminFixedTicketControlsCase,adminTicketServiceRulesCase,adminTicketLocationControlsCase,adminEventDailyLimitSettingsCase,adminPointLimitSettingsCase,adminBookingAccessibleQueueCase,adminBookingHistoryTicketSourcesCase,adminGrantNotificationControlsCase,adminBookingResourceControlsCase};\n  window.MemberAdminE2EControl ='));
  return w.nodeProbe;
}
async function adminFixture() {
  const d=dom('admin'),w=d.window;
  const config={supabaseUrl:'https://fixture.supabase.co',supabasePublishableKey:'fixture'};
  const settings={enabled:false,titleTemplate:'QA birthday',description:'Fixture',usageMethod:'Use',usageInstructions:'Once',allowedTierKeys:['general'],accent:'#df6b4d'};
  w.MemberE2EScenarioGraph=require('../../e2e-scenario-graph.js');
  w.MemberSystem={bindDialogKeyboard(){},loadConfig:async()=>config,signIn:async()=> 'fixture',getSession:()=>({config,idToken:'fixture'}),subscribeRealtime:()=>()=>{},
    request:async(_config,_type,_token,action)=>({profile:{displayName:'QA'},role:'Admin',members:[],cards:[],tickets:[],eventTickets:[],calendarItems:[],messagePresets:[],stats:{},
      memberPage:{page:1,pageSize:100,total:0,totalPages:1},tierSettings:['general','silver','gold','platinum'].map((tierKey,i)=>({tierKey,requiredServiceMinutes:i*60,styleKey:'classic'}))})};
  w.fetch=async(url)=>{
    assert.ok(!String(url).includes('birthday-benefits'),'retired birthday endpoint must never be used');
    return {ok:true,status:200,json:async()=>({ok:true,data:{templates:[],settings,maxTicketsPerDay:0,maxTicketsPerRedemption:0,accessibleRecords:[]}})};
  };
  for(const file of ['admin-session.js','coupon-location-editor.js','app.js','fixed-ticket-admin-integration.js','fixed-ticket-calendar-option.js','fixed-ticket-admin.js','pointcard-redemption-limit.js','event-ticket-redemption-limit.js','grant-automation.js'])w.eval(read('admin/'+file));
  await tick();await tick();
  return {w,node:adminProbe(w),close:()=>w.close()};
}

test('new admin birthday, fixed-ticket, service-rule and location nodes use real editors',async()=>{
  const h=await adminFixture();
  try {
    for(const name of ['adminBirthdaySettingsCase','adminFixedTicketControlsCase','adminTicketServiceRulesCase','adminTicketLocationControlsCase','adminEventDailyLimitSettingsCase','adminPointLimitSettingsCase']) {
      const result=await h.node[name]();
      assert.equal(result.status,'passed',name+':'+JSON.stringify(result));
    }
    assert.equal(h.w.document.getElementById('birthdayBenefitTitleTemplate'),null);
  }finally{h.close();}
});

test('automation health node fails missing, stale, disabled or failed jobs',async()=>{
  const h=await adminFixture();
  try {
    const names=['issue-fixed-tickets','dispatch-scheduled-grant-messages','dispatch-booking-line-notifications','sync-booking-day-before-reminders','prune-e2e-failure-artifacts'];
    let jobs=names.map(name=>({name,active:true,fresh:true,lastStatus:'succeeded'}));
    h.w.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true,data:{checkedAt:new Date().toISOString(),jobs}})});
    assert.equal((await h.node.adminAutomationHealthCase()).status,'passed');
    for(const patch of [{active:false},{fresh:false},{lastStatus:'failed'}]) {
      jobs=names.map(name=>({name,active:true,fresh:true,lastStatus:'succeeded'}));Object.assign(jobs[0],patch);
      assert.equal((await h.node.adminAutomationHealthCase()).status,'failed');
    }
    jobs=[];assert.equal((await h.node.adminAutomationHealthCase()).status,'failed');
  }finally{h.close();}
});


test('receipt contract accepts both production review modes and rejects premature completion copy',async()=>{
  const d=dom('booking'),w=d.window;
  try {
    w.BookingSystem={request:async()=>({bookings:[]})};
    w.eval(read('booking/booking-receipt.js'));
    await tick();
    const node=userProbe(w);
    const title=w.document.getElementById('bookingReceiptTitle');
    const help=w.document.querySelector('#bookingReceiptModal .booking-receipt-help');
    for(const [heading,copy] of [
      ['拍攝收據並送出審核','管理端確認前，預約仍維持已確認狀態。'],
      ['拍攝收據並送出審核','管理員核對前不會完成預約。'],
      ['拍收據，請管理員登記','管理員核對服務項目後，才會登記服務時間與點數。']]) {
      title.textContent=heading;help.textContent=copy;
      assert.equal((await node.bookingReceiptReviewContractCase()).status,'passed');
    }
    title.textContent='已完成預約';help.textContent='送出後立刻完成';
    assert.equal((await node.bookingReceiptReviewContractCase()).status,'failed');
  }finally{w.close();}
});

test('cancellation verification requires matching server state and UI, recovering delayed render once',async()=>{
  const d=dom('booking'),w=d.window;
  try {
    const id='qa-booking';
    w.document.getElementById('bookingList').innerHTML='<article class="booking-item" data-booking-id="qa-booking"><span class="status-badge">等待確認</span></article>';
    let serverPending=true,refreshes=0;
    w.BookingSystem={request:async()=>({bookings:[{bookingId:id,status:'pending',cancellationRequestedAt:serverPending?'2026-10-04T00:00:00Z':null}]})};
    w.MemberClientQaHooks={surface:'booking',refresh:async()=>{refreshes++;w.document.querySelector('.status-badge').textContent='取消待確認';}};
    const node=userProbe(w);
    const recovered=await node.verifyBookingCancellation(id,10);
    assert.equal(recovered.serverPending,true);assert.equal(recovered.uiPending,true);assert.equal(refreshes,1);
    serverPending=false;
    assert.equal((await node.verifyBookingCancellation(id,10)).serverPending,false);
    serverPending=true;w.document.querySelector('.status-badge').textContent='等待確認';
    w.MemberClientQaHooks.refresh=async()=>{};
    assert.equal((await node.verifyBookingCancellation(id,10)).uiPending,false);
    assert.equal((await node.verifyBookingCancellation('other-booking',10)).serverPending,false);
  }finally{w.close();}
});
