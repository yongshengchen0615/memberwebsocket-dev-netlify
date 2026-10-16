const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {PGlite} = require('@electric-sql/pglite');
const root = path.join(__dirname,'../..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve,25));

test('accessible mode remembers preference, exposes eligible tickets safely and preserves normal booking DOM',async()=>{
  const dom = new JSDOM(read('booking/index.html'),{url:'https://example.test/booking/',runScripts:'outside-only'});
  const w = dom.window;
  try {
    let opens=0,refreshes=0;
    w.BookingReceipts={openAccessible:()=>opens++,refresh:()=>refreshes++,beginSnapshotMode:async()=>{w.dispatchEvent(new w.CustomEvent('booking:snapshot-location-state',{detail:{status:'ready'}}));},endSnapshotMode:()=>{}};
    w.BookingBenefits={getItems:()=>[],syncNow:()=>{}};
    w.eval(read('ui-components.js'));w.eval(read('booking/booking-accessible.js'));
    await tick();
    w.dispatchEvent(new w.CustomEvent('booking:member-loaded',{detail:{profile:{lineUserId:'test:member'}}}));
    const toggle=w.document.getElementById('bookingAccessibleToggle');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-pressed'),'true');
    assert.equal(w.localStorage.getItem('booking-mode:v2:test:member'),'accessible');
    assert.ok(w.document.getElementById('bookingForm'),'Existing form must survive mode switch');
    w.document.getElementById('bookingAccessibleUpload').click();
    assert.equal(opens,1); assert.ok(refreshes>0);
    w.dispatchEvent(new w.CustomEvent('booking:benefits-loaded',{detail:{items:[
      {kind:'event',selectable:true,title:'<img src=x onerror=alert(1)>',claimRequired:true},
      {kind:'points',selectable:true,title:'點數券',conditionLabel:'需身體項目'},
      {kind:'event',selectable:false,title:'已使用'},
      {kind:'points',selectable:true,title:'未來預約已保留但快照點數充足',reservedForBooking:true},
       {kind:'points',selectable:false,title:'未來預約已保留而點數不足',reservedForBooking:true},
      {kind:'calendar',selectable:true,title:'活動'},
    ]}}));
    const tickets=w.document.getElementById('bookingAccessibleTickets');
    assert.equal(tickets.children.length,3); assert.equal(tickets.querySelector('img'),null);
    assert.match(tickets.textContent,/尚未領取/); assert.match(tickets.textContent,/需身體項目/);
     assert.match(tickets.textContent,/未來預約已保留但快照點數充足/);
     assert.doesNotMatch(tickets.textContent,/未來預約已保留而點數不足/);
    assert.equal(tickets.querySelector('input'),null,'Ticket display must not silently redeem or claim');
    w.dispatchEvent(new w.CustomEvent('booking:receipts-updated',{detail:{submissions:[{status:'bound',settlement:{service_minutes:60,reward_details:[{points:2}]}}]}}));
    assert.match(w.document.getElementById('bookingAccessibleStatus').textContent,/60 分鐘.*2 點/);
    toggle.click(); assert.equal(toggle.getAttribute('aria-pressed'),'false');
    assert.ok(w.document.getElementById('bookingForm'));
  } finally {w.dispatchEvent(new w.Event('pagehide')); w.close();}
});

test('mode preferences restore per member, preserve drafts and ignore invalid or inaccessible storage',async()=>{
  const create=async(initial={},unavailable=false)=>{
    const dom=new JSDOM(read('booking/index.html'),{url:'https://example.test/booking/',runScripts:'outside-only'});
    const w=dom.window;
    for(const [key,value] of Object.entries(initial)) w.localStorage.setItem(key,value);
    if(unavailable) Object.defineProperty(w,'localStorage',{get(){throw new Error('storage unavailable');}});
    w.BookingReceipts={refresh:()=>{}}; w.BookingBenefits={getItems:()=>[]};
    w.eval(read('ui-components.js'));w.eval(read('booking/booking-accessible.js')); await tick();
    return dom;
  };
  const load=(w,id)=>w.dispatchEvent(new w.CustomEvent('booking:member-loaded',{detail:{profile:{lineUserId:id}}}));
  const dom=await create({'booking-accessible-mode':'1'}),w=dom.window;
  try {
    const toggle=w.document.getElementById('bookingAccessibleToggle');
    load(w,'test:mode-a'); assert.equal(toggle.getAttribute('aria-pressed'),'false');
    assert.equal(w.localStorage.getItem('booking-mode:v2:test:mode-a'),null,'Loading must not overwrite preferences');
    const note=w.document.getElementById('memberNote'); note.value='unsent draft';
    toggle.click(); assert.equal(w.localStorage.getItem('booking-mode:v2:test:mode-a'),'accessible');
    toggle.click(); assert.equal(note.value,'unsent draft');
    toggle.click();
    load(w,'test:mode-b'); assert.equal(toggle.getAttribute('aria-pressed'),'false');
    assert.equal(w.localStorage.getItem('booking-mode:v2:test:mode-b'),null);
    load(w,'test:mode-a'); assert.equal(toggle.getAttribute('aria-pressed'),'true');
    assert.equal(w.document.getElementById('bookingView').classList.contains('hidden'),true,'Restore occurs before the booking view is revealed');
    toggle.click(); assert.equal(w.localStorage.getItem('booking-mode:v2:test:mode-a'),'general');
  } finally {w.close();}
  for(const preference of ['accessible','general','invalid']) {
    const next=await create({'booking-mode:v2:test:mode-a':preference});
    try {
      load(next.window,'test:mode-a');
      assert.equal(next.window.document.getElementById('bookingAccessibleToggle').getAttribute('aria-pressed'),String(preference==='accessible'));
    } finally {next.window.close();}
  }
  const blocked=await create({},true);
  try {
    const bw=blocked.window,toggle=bw.document.getElementById('bookingAccessibleToggle');
    load(bw,'test:mode-a'); assert.equal(toggle.getAttribute('aria-pressed'),'false');
    toggle.click(); assert.equal(toggle.getAttribute('aria-pressed'),'true');
    load(bw,'test:mode-b'); assert.equal(toggle.getAttribute('aria-pressed'),'false');
  } finally {blocked.window.close();}
});

test('admin receipt queue registers actual minutes with one locked submission and exposes missing reward rules',async()=>{
  const dom=new JSDOM('<section id="bookingAdminQueuePanel"></section>',{url:'https://example.test/admin/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window; const registrations=[]; let resolveRegister; let completedRecord=null;
  try {
    const receipt={receiptId:'BR-fixture',updatedAt:'2026-10-03T00:00:00Z',memberName:'Member',memberCode:'M',createdAt:'2026-10-03T00:00:00Z'};
    w.MemberSystem={getSession:()=>({config:{},idToken:'admin-fixture'}),request:async(c,t,token,action,payload)=>{
      if(action.endsWith('.url')) return {signedUrl:'https://example.test/receipt.jpg'};
      if(action.endsWith('.options')) return {
        services:[{id:'service',title:'Body',service_type:'body',duration_minutes:30}],
        bookings:[],primaryTechnicianConfigured:true,rewardRules:[],
        benefitCatalog:{
          eventTicketMaxPerDay:1,pointTicketMaxPerRedemption:3,
          items:[
            {kind:'points',selectionId:'point-ticket',selectable:true,title:'Body Ticket',subtitle:'消耗 3 點',pointCost:3,pointBalance:5,cardId:'card',cardTitle:'Body Card',requiredServiceIds:['service'],requiredServiceMatchMode:'any'},
            {kind:'points',selectionId:'point-ticket-2',selectable:true,title:'Body Ticket 2',subtitle:'消耗 3 點',pointCost:3,pointBalance:5,cardId:'card',cardTitle:'Body Card',requiredServiceIds:['service'],requiredServiceMatchMode:'any'},
            {kind:'event',selectionId:'',selectable:false,title:'Unclaimed Event',claimRequired:true,disabledReason:'會員尚未領取此活動票券；管理員不可代替會員領取。'}
          ]
        },
        currentBenefits:[],currentBookingServiceIds:[],currentBookingStatus:''
      };
      if(action.endsWith('.register')) {
        registrations.push(payload);
        return new Promise(resolve=>{resolveRegister=value=>{
          completedRecord={
            receiptId:'BR-fixture',bookingId:value.bookingId,status:'bound',reviewStatus:'completed',
            memberName:'Member',memberCode:'M',createdAt:'2026-10-03T00:00:00Z',updatedAt:'2026-10-03T01:00:00Z',completedAt:'2026-10-03T01:00:00Z',
            bookingDate:'2020-01-01',startTime:'10:03',serviceMinutes:60,points:2,
            services:[{title:'Body',minutes:60,quantity:1,serviceType:'body'}],
            benefits:[{kind:'points',title:'Body Ticket',status:'redeemed'}]
          };
          resolve(value);
        };});
      }
      if(action.endsWith('.list')) return {submissions:[],accessibleRecords:completedRecord?[completedRecord]:[]};
      return {submissions:[]};
    }};
    w.eval(read('admin/booking-accessible-admin.js')); await tick();
    w.dispatchEvent(new w.CustomEvent('admin:accessible-receipts-updated',{detail:{submissions:[receipt]}}));
    w.document.querySelector('#accessibleAdminQueueList button').click(); await tick();
    assert.match(w.document.getElementById('accessibleAdminMessage').textContent,/未設定服務集點規則/);
    const row=w.document.querySelector('.accessible-admin-item');
    const check=row.querySelector('[data-service-check]'); check.checked=true; check.dispatchEvent(new w.Event('change'));
    row.querySelector('[data-minutes]').value='60';
    const benefitChecks=w.document.querySelectorAll('[data-benefit-check]');
    assert.equal(benefitChecks.length,3);
    assert.equal(benefitChecks[0].disabled,false);
    assert.equal(benefitChecks[1].disabled,false);
    assert.equal(benefitChecks[2].disabled,true);
    assert.match(w.document.getElementById('accessibleAdminBenefits').textContent,/Unclaimed Event/);
    benefitChecks[0].checked=true; benefitChecks[0].dispatchEvent(new w.Event('change'));
    const pointSummary=w.document.getElementById('accessibleAdminPointSummary').textContent;
    assert.match(pointSummary,/Body Card/); assert.match(pointSummary,/目前可用5 點/); assert.match(pointSummary,/本次扣除3 點/); assert.match(pointSummary,/審核後剩餘2 點/);
    assert.equal(benefitChecks[1].disabled,true,'A second 3-point ticket must be blocked when only 2 points remain');
    w.document.getElementById('accessibleAdminDate').value='2020-01-01';
    const timeInput=w.document.getElementById('accessibleAdminTime');
    assert.equal(timeInput.step,'60');
    timeInput.value='10:03';
    const form=w.document.getElementById('accessibleAdminForm');
    form.dispatchEvent(new w.Event('submit',{cancelable:true})); form.dispatchEvent(new w.Event('submit',{cancelable:true})); await tick();
    assert.equal(registrations.length,1); assert.equal(registrations[0].startTime,'10:03'); assert.deepEqual(JSON.parse(JSON.stringify(registrations[0].items)),[{serviceId:'service',minutes:60,quantity:1}]);
    assert.deepEqual(JSON.parse(JSON.stringify(registrations[0].benefits)),[{kind:'points',id:'point-ticket'}]);
    assert.equal(w.document.getElementById('accessibleAdminClose').disabled,true);
    resolveRegister({bookingId:'booking',settlement:{serviceMinutes:60,rewards:[{points:2}]}}); await tick();
    assert.equal(w.document.getElementById('accessibleAdminModal').classList.contains('hidden'),true);
    assert.match(w.document.getElementById('accessibleAdminQueueList').textContent,/Body.*60 分鐘.*新增 2 點.*核銷 1 張票券/);
    assert.equal(w.document.querySelector('[data-accessible-filter="completed"]').classList.contains('active'),true);
    const recordButton=w.document.getElementById('accessibleAdminQueueList').querySelector('button');
    assert.equal(recordButton.textContent,'查看紀錄');
    recordButton.click(); await tick();
    assert.match(w.document.getElementById('accessibleAdminRecordStats').textContent,/60 分鐘.*2 點.*1 張/);
    assert.match(w.document.getElementById('accessibleAdminRecordServices').textContent,/Body/);
    const benefitRecord=w.document.getElementById('accessibleAdminRecordBenefits');
    const ticketCard=benefitRecord.querySelector('.booking-ticket-card.kind-points');
    assert.ok(ticketCard,'Completed accessible records should render a point-ticket card');
    assert.equal(ticketCard.querySelector('.booking-ticket-kind')?.textContent,'集點卡票券');
    assert.equal(ticketCard.querySelector('.booking-ticket-status')?.textContent,'已核銷');
    assert.equal(ticketCard.querySelector('.booking-ticket-field strong')?.textContent,'Body Ticket');
  } finally {w.dispatchEvent(new w.Event('pagehide')); w.close();}
});

test('accessible receipt camera sends a receipt without a booking and locks duplicate clicks',async()=>{
  const dom=new JSDOM('<div id="bookingView"></div>',{url:'https://example.test/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window; const calls=[];
  try {
    Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:ok=>ok({coords:{latitude:25.03,longitude:121.56,accuracy:15},timestamp:Date.now()})}});
    Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
    w.HTMLMediaElement.prototype.play=async()=>{};
    w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){}});
    w.HTMLCanvasElement.prototype.toBlob=cb=>cb(new w.Blob(['image'],{type:'image/jpeg'}));
    let resolveFinalize;
    const finalize=new Promise(resolve=>{resolveFinalize=resolve;});
    w.BookingSystem={getSession:()=>({config:{},idToken:'fixture'}),request:async(c,t,token,action,payload)=>{
      calls.push({action,payload});
      if(action.endsWith('.prepare'))return {receiptId:'receipt',objectPath:'path',uploadToken:'token'};
      if(action.endsWith('.finalize'))return finalize;
      return {bookings:[],submissions:[],snapshotLocationRequired:false,snapshotLocations:[]};
    }};
    w.supabase={createClient:()=>({storage:{from:()=>({uploadToSignedUrl:async()=>({})})}})};
    w.eval(read('booking/booking-receipt.js'));
    w.BookingReceipts.openAccessible(); await tick();
    const video=w.document.getElementById('bookingReceiptCamera');
    Object.defineProperty(video,'videoWidth',{value:100}); Object.defineProperty(video,'videoHeight',{value:100});
    w.document.getElementById('bookingReceiptCapture').click(); await tick();
    const submit=w.document.getElementById('bookingReceiptSubmit'); submit.click(); submit.dispatchEvent(new w.Event('click')); await tick();
    const prepares=calls.filter(c=>c.action.endsWith('.prepare'));
    assert.equal(prepares.length,1); assert.equal(prepares[0].payload.accessible,true); assert.equal(prepares[0].payload.bookingId,undefined);
    assert.equal(submit.disabled,true);
    resolveFinalize({receiptId:'receipt',status:'awaiting_review'}); await tick();
    assert.equal(submit.disabled,true);
  } finally {w.dispatchEvent(new w.Event('pagehide')); w.close();}
});

test('accessible E2E screen snapshot hook is test-session gated and skips the physical camera',async()=>{
  const dom=new JSDOM('<div id="bookingView"></div>',{url:'https://example.test/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window; let cameraCalls=0;
  try {
    Object.defineProperty(w.navigator,'geolocation',{value:{getCurrentPosition:ok=>ok({coords:{latitude:25.03,longitude:121.56,accuracy:15},timestamp:Date.now()})}});
    Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:async()=>{cameraCalls+=1;throw new Error('camera must not run');}}});
    w.BookingSystem={getSession:()=>({config:{},idToken:'fixture'}),request:async()=>({bookings:[],submissions:[],snapshotLocationRequired:false,snapshotLocations:[]})};
    w.supabase={createClient:()=>({storage:{from:()=>({uploadToSignedUrl:async()=>({})})}})};
    w.eval(read('booking/booking-receipt.js'));

    await assert.rejects(
      ()=>w.BookingReceipts.openAccessibleE2ESnapshot(new w.Blob(['snapshot'],{type:'image/webp'})),
      error=>error?.code==='TEST_SESSION_REQUIRED'
    );

    w.TestModeClient={getSessionToken:()=> 'qa-test-session'};
    const meta=await w.BookingReceipts.openAccessibleE2ESnapshot(new w.Blob(['snapshot'],{type:'image/webp'}));
    assert.equal(meta.mimeType,'image/webp');
    assert.ok(meta.sizeBytes>0);
    await tick();
    assert.equal(cameraCalls,0,'E2E screenshot injection must not request a physical camera');
    assert.equal(w.document.getElementById('bookingReceiptModal').classList.contains('hidden'),false);
    assert.equal(w.document.getElementById('bookingReceiptSubmit').disabled,false);
    assert.match(w.document.getElementById('bookingReceiptPreview').getAttribute('src')||'',/^data:image\/webp/);
  } finally {w.dispatchEvent(new w.Event('pagehide'));w.close();}
});

test('receipt registration is owner scoped, atomic, replay safe, records real points/minutes and retains online time guards',async()=>{
  const db=new PGlite();
  const member='10000000-0000-4000-8000-000000000001';
  const other='10000000-0000-4000-8000-000000000002';
  const service='20000000-0000-4000-8000-000000000001';
  const technician='30000000-0000-4000-8000-000000000001';
  const card='40000000-0000-4000-8000-000000000001';
  const type='50000000-0000-4000-8000-000000000001';
  try {
    await db.exec('create role anon;create role authenticated;create role service_role;');
    await db.exec(read('tests/integration/booking_accessible_schema.sql'));
    await db.exec(read('supabase/migrations/20260919114412_primary_technician_only_completion_rewards.sql'));
    const confirmation=read('supabase/migrations/20261001125500_booking_receipt_admin_confirmation.sql');
    await db.exec(confirmation.slice(confirmation.indexOf('create or replace function public.admin_confirm_booking_receipt_request'),confirmation.indexOf('create or replace function public.fail_booking_receipt_request')));
    await db.exec(read('supabase/migrations/20261003104741_booking_accessible_receipt_registration.sql'));
    await db.exec(`insert into members(id,line_user_id,member_code,membership_status) values('${member}','fixture','A','active'),('${other}','other','B','active');
      insert into admins(line_user_id,role,status) values('admin','admin','active');
      insert into booking_technicians(id,name) values('${technician}','primary');
      insert into booking_settings(primary_technician_id) values('${technician}');
      insert into booking_services(id,title,created_by,duration_minutes,service_type) values('${service}','body','fixture',30,'body'),('00000000-0000-4000-8000-000000000010','store','fixture',5,'store');
      insert into booking_service_types(id,name) values('${type}','body');
      insert into point_cards(id,card_id,title,status,expiry_mode,created_by,updated_by) values('${card}','CARD','card','active','unlimited','fixture','fixture');
      insert into booking_service_type_rewards(service_type_id,point_card_id,minutes_per_point) values('${type}','${card}',30);
    `);
    const prepare=async(id,owner=member,size=100)=>(await db.query('select prepare_accessible_receipt_request($1,$2,$3,$4,$5) result',[owner,id,`${owner}/accessible/${id}.jpg`,'image/jpeg',size])).rows[0].result;
    const finalize=async(id,owner=member,size=100)=>(await db.query('select finalize_accessible_receipt_request($1,$2,$3,$4,$5,$6) result',[id,owner,owner===member?'fixture':'other','image/jpeg',size,'a'.repeat(64)])).rows[0].result;
    const items=[{serviceId:service,minutes:60,quantity:1}];
    const register=async(id,actor='admin',chosen=items,date='2020-01-01',existing=null)=>{
      const r=(await db.query('select updated_at from booking_receipts where receipt_id=$1',[id])).rows[0];
      return (await db.query('select register_accessible_receipt_request($1,$2,$3,$4,$5,$6,$7,$8) result',[id,r.updated_at,actor,existing,date,'10:00',JSON.stringify(chosen),'checked'])).rows[0].result;
    };
    const first=await prepare('accessible-first');
    await assert.rejects(finalize(first.receiptId,other),/RECEIPT_NOT_OWNED/);
    await finalize(first.receiptId);
    const second=await prepare('accessible-second');
    await assert.rejects(finalize(second.receiptId,member,101),/RECEIPT_SIZE_MISMATCH/);
    assert.equal((await db.query("select count(*)::int n from booking_receipts where status='awaiting_review'")).rows[0].n,1);
    await finalize(second.receiptId); await assert.rejects(finalize(first.receiptId),/RECEIPT_NOT_PENDING/);
    await assert.rejects(register(second.receiptId,'not-admin'),/ADMIN_REQUIRED/);
    await assert.rejects(register(second.receiptId,'admin',[{serviceId:service,minutes:0,quantity:1}]),/INVALID_BOOKING_ITEMS/);
    await assert.rejects(register(second.receiptId,'admin',items,'2099-01-01'),/BOOKING_NOT_FINISHED_YET/);
    assert.equal((await db.query('select count(*)::int n from bookings')).rows[0].n,0);
    const result=await register(second.receiptId);
    assert.equal(result.settlement.serviceMinutes,60); assert.equal(result.settlement.rewards[0].points,2);
    assert.equal((await register(second.receiptId)).alreadyApplied,true);
    assert.equal((await db.query('select count(*)::int n from bookings')).rows[0].n,1);
    assert.equal((await db.query('select sum(minutes)::int n from service_time_entries')).rows[0].n,60);
    assert.equal((await db.query('select sum(amount)::int n from point_entries')).rows[0].n,2);
    const third=await prepare('accessible-third'); await finalize(third.receiptId);
    await assert.rejects(register(third.receiptId,'admin',items,'2020-01-01',result.bookingId),/BOOKING_ALREADY_COMPLETED_WITH_RECEIPT/);
    // Regular reservations still obey advance/live-clock rules.
    await assert.rejects(db.exec(`insert into bookings(request_id,service_id,member_id,booking_date,start_time,end_time) values('online-request','${service}','${member}','2020-01-01','10:00','10:30')`),/BOOKING_TOO_EARLY|BOOKING_TIME_PASSED/);
    for(const role of ['anon','authenticated']) {
      await db.exec(`set role ${role};`);
      await assert.rejects(prepare('accessible-denied'),/permission denied/);
      await assert.rejects(db.query('select register_accessible_receipt_request($1,null,$2,null,null,null,$3,$4)',[third.receiptId,'admin','[]','']),/permission denied/);
      await db.exec('reset role;');
    }
  } finally {await db.close();}
});
