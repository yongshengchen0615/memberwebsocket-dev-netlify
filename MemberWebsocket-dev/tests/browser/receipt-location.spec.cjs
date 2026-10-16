const {test,expect}=require('playwright/test');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
let server,base;
const runs=new Map();
const fixtureScripts=new Map();
const blank=()=>({prepare:[],finalize:[],uploads:[],redeem:[],claimCalls:[],claimed:false,attempts:0,status:'confirmed'});
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
function shell(surface,run,mode) {
  const html=fs.readFileSync(path.join(root,surface,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
  const fixture=`
    const run=${JSON.stringify(run)},mode=${JSON.stringify(mode)};
    window.fixtureStreams=[];window.fixtureEvents=0;
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let denied=mode==='camera-denied';
    navigator.mediaDevices.getUserMedia=async constraints=>{if(denied){denied=false;throw new DOMException('Permission denied','NotAllowedError');}const stream=await original(constraints);window.fixtureStreams.push(stream);return stream;};
    async function request(_config,_type,_token,action,payload={}){const response=await fetch('/api?run='+run+'&mode='+mode,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,payload})});const body=await response.json();if(!response.ok)throw Object.assign(new Error(body.message),{code:body.code});return body;}
    const config={supabaseUrl:location.origin,supabasePublishableKey:'local-fixture'};
    window.BookingSystem={getSession:()=>({config,idToken:'local-fixture'}),request,claimEventTicket:(_config,_token,eventTicketId)=>request(config,'booking','local-fixture','user.booking.event-ticket.claim',{eventTicketId})};
    window.supabase={createClient:()=>({storage:{from:()=>({uploadToSignedUrl:async(objectPath,token,file,options)=>{const response=await fetch('/upload?run='+run+'&token='+token,{method:'PUT',headers:{'Content-Type':options.contentType},body:file});return {error:response.ok?null:Object.assign(new Error('Upload unavailable'),{code:'RECEIPT_UPLOAD_UNAVAILABLE'})};}})}})};
    window.addEventListener('booking:accessible-receipt-submitted',()=>window.fixtureEvents++);
    window.MemberSystem={loadConfig:async()=>config,signIn:async()=> 'local-fixture',request,subscribeRealtime:()=>()=>{},bindDialogKeyboard(){}};
    window.MembershipProgress={render(){}};
  `;
  fixtureScripts.set(run,fixture);
  return html.replace(/href="\.\//g,`href="/${surface}/`).replace('</body>',`<script src="/fixture.js?run=${encodeURIComponent(run)}"></script><script src="/ticket-booking-choice.js"></script><script src="/event-ticket-ui.js"></script><script src="/ticket-live-location.js"></script><script src="/${surface==='booking'?'booking/booking-receipt.js':'event/app.js'}"></script></body>`);
}
test.beforeAll(async()=>{
  server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      const run=url.searchParams.get('run');
      if(url.pathname==='/fixture.js') {res.writeHead(200,{'Content-Type':'text/javascript'});res.end(fixtureScripts.get(run));return;}
      if(url.pathname==='/receipt'||url.pathname==='/geo') {
        runs.set(run,blank());res.writeHead(200,{'Content-Type':'text/html'});res.end(shell(url.pathname==='/receipt'?'booking':'event',run,url.searchParams.get('mode')||''));return;
      }
      if(url.pathname==='/api'||url.pathname==='/upload') {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=Buffer.concat(chunks),state=runs.get(run);
        if(url.pathname==='/upload') {
          state.uploads.push({size:data.length,type:req.headers['content-type'],jpeg:data[0]===255&&data[1]===216,token:url.searchParams.get('token')});
          if(url.searchParams.get('mode')==='unused')return json(res,{},503);
          return json(res,{});
        }
        const {action,payload}=JSON.parse(data);
        if(action==='user.booking.receipt.prepare') {
          state.prepare.push(payload);return json(res,{receiptId:'QA-RECEIPT',objectPath:'qa/receipt.jpg',uploadToken:'qa-token'});
        }
        if(action==='user.booking.receipt.finalize') {
          state.finalize.push(payload);state.status='awaiting_review';
          if(url.searchParams.get('mode')==='uncertain'&&state.finalize.length===1)return json(res,{code:'API_RESPONSE_UNCERTAIN',message:'Uncertain result'},503);
          return json(res,{receiptId:'QA-RECEIPT',status:'awaiting_review',alreadyApplied:state.finalize.length>1});
        }
        if(action==='user.booking.event-ticket.claim') {
          state.claimCalls.push(payload);
          if(payload.eventTicketId!=='QA-UNCLAIMED')return json(res,{code:'EVENT_NOT_FOUND',message:'Wrong event'},400);
          state.claimed=true;
          return json(res,{ticket:{claimId:'QA-NEW-CLAIM'},alreadyClaimed:false});
        }
        if(action==='user.booking.receipt.options'&&url.searchParams.get('mode')==='ticket-limits')return json(res,{
          pointTicketMaxPerRedemption:2,eventTicketMaxPerDay:2,usedTodayCount:1,
          items:[
            {kind:'points',selectionId:'QA-P1',title:'A 卡票券 1',cardId:'card-A',cardTitle:'A 卡',pointCost:5,pointBalance:8,selectable:true},
            {kind:'points',selectionId:'QA-P2',title:'A 卡票券 2',cardId:'card-A',cardTitle:'A 卡',pointCost:5,pointBalance:8,selectable:true},
            {kind:'points',selectionId:'QA-P3',title:'B 卡票券 1',cardId:'card-B',cardTitle:'B 卡',pointCost:1,pointBalance:20,selectable:true},
            {kind:'points',selectionId:'QA-P4',title:'B 卡票券 2',cardId:'card-B',cardTitle:'B 卡',pointCost:1,pointBalance:20,selectable:true},
            {kind:'event',selectionId:'QA-E1',title:'活動票券 1',selectable:true},
            {kind:'event',selectionId:'QA-E2',title:'活動票券 2',selectable:true}
          ]
        });
        if(action==='user.booking.receipt.options'&&url.searchParams.get('mode')==='unclaimed-event')return json(res,{
          ticketBookingRequired:false,items:[state.claimed
            ? {kind:'event',id:'QA-UNCLAIMED',selectionId:'QA-NEW-CLAIM',title:'QA new event',claimRequired:false,
                selectable:Boolean(payload.location?.latitude),requiresLocation:true,disabledReason:'快照 GPS 未通過定位驗證'}
            : {kind:'event',id:'QA-UNCLAIMED',selectionId:'',title:'QA new event',claimRequired:true,
                selectable:false,requiresLocation:true,disabledReason:'會員尚未領取'}
          ]
        });
        if(action==='user.booking.receipt.options')return json(res,{ticketBookingRequired:url.searchParams.get('mode')==='tickets-required',items:[{kind:'event',selectionId:'QA-TICKET',title:'QA held ticket',selectable:true,eligibleBookings:[]},{kind:'event',selectionId:'QA-EXPIRED',title:'Expired',selectable:false,disabledReason:'票券已過期'}]});
        if(action==='user.booking.receipt.list')return json(res,{snapshotLocationRequired:['location-required','unclaimed-event'].includes(url.searchParams.get('mode')),snapshotLocations:[{name:'QA 指定門市',latitude:25.033964,longitude:121.564468,radiusMeters:100}],bookings:[],submissions:[]});
        if(action==='user.event.bootstrap')return json(res,{profile:{displayName:'QA',tierKey:'general'},usedTickets:[],usedTicketCount:0,offers:[{
          ticket:{eventTicketId:'QA-GEO',title:'GPS QA',ticketType:'coupon',description:'GPS receipt QA',usageMethod:'Once',usageInstructions:'Once',requiresLocation:true,redemptionLocations:[{name:'QA 指定門市',latitude:25.033964,longitude:121.564468,radiusMeters:100}],allowedTierKeys:['general'],prizes:[]},
          claim:{claimId:'QA-CLAIM',status:'claimed',ticketTitle:'GPS QA',ticketDescription:'GPS receipt QA',ticketType:'coupon'},eligibleBookings:[{bookingId:'00000000-0000-4000-8000-000000000001',bookingDate:'2099-01-01',startTime:'10:00',title:'GPS booking'}],canUse:true,availability:'open',tierEligible:true
        }]});
        if(action==='user.event.ticket.redeem') {
          state.redeem.push(payload);
          if(Math.abs(payload.location.latitude-25.033964)>.001)return json(res,{code:'LOCATION_OUT_OF_RANGE',message:'超出核銷範圍'},400);
          return json(res,{ticket:{claimId:'QA-CLAIM',eventTicketId:'QA-GEO',status:'used',ticketTitle:'GPS QA',ticketDescription:'GPS receipt QA',ticketType:'coupon',usedAt:new Date().toISOString()}});
        }
        return json(res,{code:'UNKNOWN_ACTION',message:action},400);
      }
      const file=path.resolve(root,'.'+url.pathname);
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,{},404);
      res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream'});fs.createReadStream(file).pipe(res);
    }catch(error){json(res,{message:error.message},500);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{await new Promise(resolve=>server.close(resolve));});
test.beforeEach(async({page})=>{await page.route('https://**',route=>route.abort());page.on('dialog',dialog=>dialog.accept());});
async function open(page,run,mode='',accessible=true) {
  // Policy OFF needs only camera permission. A GPS-restricted ticket fixture
  // enables snapshot GPS explicitly and gets geolocation permission.
  if (accessible && mode !== 'location-required') {
    await page.context().grantPermissions(mode === 'unclaimed-event' ? ['geolocation','camera'] : ['camera'],{origin:base});
    if (mode === 'unclaimed-event') await page.context().setGeolocation({latitude:25.033964,longitude:121.564468,accuracy:10});
  }
  await page.goto(base+'/receipt?run='+run+'&mode='+mode);
  expect(await page.evaluate(()=>typeof window.BookingSystem?.getSession)).toBe('function');
  await page.evaluate(accessible=>accessible?window.BookingReceipts.openAccessible():window.BookingReceipts.openBooking('QA-BOOKING','version-1'),accessible);
}

test('snapshot positioning policy blocks denied GPS and successful retries send fresh evidence',async({page,context})=>{
 const run='snapshot-location-policy';
 await open(page,run,'location-required');
 await expect(page.locator('#bookingReceiptMessage')).toContainText('定位權限未開啟');
 await expect(page.locator('#bookingReceiptFile')).toBeDisabled();expect(runs.get(run).prepare).toHaveLength(0);
 await context.grantPermissions(['geolocation'],{origin:base});await context.setGeolocation({latitude:25.033964,longitude:121.564472,accuracy:10});
 await page.locator('#bookingReceiptCapture').click();await expect(page.locator('#bookingReceiptCapture')).toHaveText('拍攝收據');
 await page.locator('#bookingReceiptCapture').click();await expect(page.locator('#bookingReceiptSubmit')).toBeEnabled();
 await page.locator('#bookingReceiptSubmit').click();await expect(page.locator('#bookingReceiptModal')).toBeHidden();
 const state=runs.get(run);expect(state.prepare).toHaveLength(1);expect(state.finalize).toHaveLength(1);
 expect(state.prepare[0].location).toMatchObject({latitude:25.033964,longitude:121.564472,accuracy:10});
 expect(state.finalize[0].location.timestamp).toBeGreaterThan(Date.now()-120000);
});
test('snapshot policy OFF permits receipt upload with location permission unavailable',async({page})=>{
  const run='snapshot-location-optional';
  await open(page,run);
  await expect(page.locator('#bookingReceiptCapture')).toHaveText('拍攝收據');
  await expect(page.locator('#bookingReceiptFile')).toBeEnabled();
  await capture(page);
  await page.locator('#bookingReceiptSubmit').click();
  await expect(page.locator('#bookingReceiptModal')).toBeHidden();
  const state=runs.get(run);
  expect(state.prepare).toHaveLength(1);
  expect(state.finalize).toHaveLength(1);
  expect(state.prepare[0].location).toBeNull();
  expect(state.finalize[0].location).toBeNull();
});

async function capture(page,{screenSnapshot=false}={}) {
  let snapshotSize=0;
  await expect(page.locator('#bookingReceiptCapture')).toHaveText('拍攝收據');
  if(screenSnapshot) {
    await page.evaluate(()=>{
      const existing=document.getElementById('e2eReceiptSnapshotSource'); if(existing)existing.remove();
      const source=document.createElement('article');
      source.id='e2eReceiptSnapshotSource';
      source.setAttribute('aria-label','E2E 快照收據替代快照');
      source.style.cssText='width:360px;padding:24px;background:#fff;color:#111;border:2px solid #222;font:16px/1.6 sans-serif';
      source.innerHTML='<strong>E2E 快照收據快照</strong><p>測試服務：QA Body Service</p><p>金額：NT$ 100</p><p>用途：以螢幕快照代替實體收據照片</p>';
      document.querySelector('.booking-receipt-modal-card')?.append(source);
    });
    const snapshot=await page.locator('#e2eReceiptSnapshotSource').screenshot({type:'jpeg',quality:84});
    snapshotSize=snapshot.length;
    await page.evaluate((bytes)=>{
      const canvas=document.getElementById('bookingReceiptCanvas');
      const original=canvas.toBlob.bind(canvas);
      canvas.toBlob=(callback)=>{
        canvas.toBlob=original;
        callback(new Blob([Uint8Array.from(bytes)],{type:'image/jpeg'}));
      };
    },Array.from(snapshot));
  }
  await page.locator('#bookingReceiptCapture').click();
  await expect(page.locator('#bookingReceiptSubmit')).toBeEnabled();
  await expect(page.locator('#bookingReceiptPreview')).toHaveAttribute('src',/^data:image\/jpeg/);
  return snapshotSize;
}
for(const accessible of [true,false])test(`${accessible?'accessible':'booking'} camera to JPEG, signed upload, finalize and review boundary`,async({page})=>{
  const run='receipt-'+accessible;await open(page,run,'',accessible);
  const screenshotSize=await capture(page,{screenSnapshot:accessible});
  await page.locator('#bookingReceiptSubmit').click();
  await expect(page.locator('#bookingReceiptModal')).toBeHidden();
  const state=runs.get(run);expect(state.prepare).toHaveLength(1);expect(state.finalize).toHaveLength(1);expect(state.uploads).toHaveLength(1);
  expect(state.prepare[0].mimeType).toBe('image/jpeg');expect(state.prepare[0].sizeBytes).toBeGreaterThan(100);
  expect(state.uploads[0]).toMatchObject({jpeg:true,type:'image/jpeg',token:'qa-token'});
  if(accessible) {
    expect(screenshotSize).toBeGreaterThan(100);
    expect(state.uploads[0].size).toBe(screenshotSize);
  }
  expect(state.status).toBe('awaiting_review');expect(state.prepare[0].accessible===true).toBe(accessible);
  expect(state.finalize[0].expectedUpdatedAt).toBe(accessible?'':'version-1');
  expect(await page.evaluate(()=>fixtureEvents)).toBe(accessible?1:0);
  expect(await page.evaluate(()=>fixtureStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')))).toBe(true);
});
test('denied camera permission can retry and closing releases the real video stream',async({page})=>{
  await open(page,'permission','camera-denied');
  await expect(page.locator('#bookingReceiptMessage')).toContainText('相機');
  await page.locator('#bookingReceiptCapture').click();await expect(page.locator('#bookingReceiptCapture')).toHaveText('拍攝收據');
  await page.locator('#bookingReceiptCancel').click();await expect(page.locator('#bookingReceiptModal')).toBeHidden();
  expect(await page.evaluate(()=>fixtureStreams.length===1&&fixtureStreams[0].getTracks().every(track=>track.readyState==='ended'))).toBe(true);
  expect(runs.get('permission').prepare).toHaveLength(0);
});
test('retake replaces the image without sending the discarded capture',async({page})=>{
  await open(page,'retake');await capture(page);await page.locator('#bookingReceiptRetake').click();
  await expect(page.locator('#bookingReceiptSubmit')).toBeDisabled();await capture(page);
  await page.locator('#bookingReceiptSubmit').click();await expect(page.locator('#bookingReceiptModal')).toBeHidden();
  expect(runs.get('retake').uploads).toHaveLength(1);
  expect(await page.evaluate(()=>fixtureStreams.length)).toBe(2);
});
test('uncertain finalize retry preserves receipt and does not repeat prepare or upload',async({page})=>{
  await open(page,'uncertain','uncertain');await capture(page);await page.locator('#bookingReceiptSubmit').click();
  await expect(page.locator('#bookingReceiptMessage')).toContainText('無法確認');
  await expect(page.locator('#bookingReceiptSubmit')).toBeEnabled();await page.locator('#bookingReceiptSubmit').click();
  await expect(page.locator('#bookingReceiptModal')).toBeHidden();
  const state=runs.get('uncertain');expect(state.prepare).toHaveLength(1);expect(state.uploads).toHaveLength(1);expect(state.finalize).toHaveLength(2);
  expect(state.finalize[0]).toEqual(state.finalize[1]);
});
test('double submit is locked until upload/finalize finishes',async({page})=>{
  await open(page,'double');await capture(page);
  await page.evaluate(()=>{document.getElementById('bookingReceiptSubmit').click();document.getElementById('bookingReceiptSubmit').click();});
  await expect(page.locator('#bookingReceiptModal')).toBeHidden();expect(runs.get('double').prepare).toHaveLength(1);expect(runs.get('double').finalize).toHaveLength(1);
});
test('GPS permission denial cannot dispatch redemption; permission retry sends actual coordinates',async({page,context})=>{
  await page.goto(base+'/geo?run=gps-permission');await page.locator('[data-event-ticket-id="QA-GEO"]').first().click();
  await expect(page.locator('#ticketModalLocationStatus')).toContainText('定位遭拒');
  await expect(page.locator('#ticketModalAction')).toBeDisabled();
  expect(runs.get('gps-permission').redeem).toHaveLength(0);
  await context.grantPermissions(['geolocation']);await context.setGeolocation({latitude:25.033964,longitude:121.564468,accuracy:10});
  await page.locator('#ticketModalLocationButton').click();
  await expect(page.locator('#ticketModalLocationStatus')).toContainText('QA 指定門市');
  await expect(page.locator('#ticketModalAction')).toBeEnabled();
  await page.locator('#ticketModalAction').click();await expect(page.locator('#ticketModalResult')).toBeVisible();
  expect(runs.get('gps-permission').redeem[0].location).toMatchObject({latitude:25.033964,longitude:121.564468,accuracy:10});
});
test('GPS out of range keeps ticket usable and a new in-range fix can retry',async({page,context})=>{
  await context.grantPermissions(['geolocation']);await context.setGeolocation({latitude:24,longitude:120,accuracy:10});
  await page.goto(base+'/geo?run=gps-range');await page.locator('[data-event-ticket-id="QA-GEO"]').first().click();
  await expect(page.locator('#ticketModalLocationStatus')).toContainText('目前不在可使用範圍');
  await expect(page.locator('#ticketModalAction')).toBeDisabled();
  expect(runs.get('gps-range').redeem).toHaveLength(0);
  await context.setGeolocation({latitude:25.033964,longitude:121.564468,accuracy:5});
  await expect(page.locator('#ticketModalLocationStatus')).toContainText('符合「QA 指定門市」');
  await expect(page.locator('#ticketModalAction')).toBeEnabled();
  await page.locator('#ticketModalAction').click();
  await expect(page.locator('#ticketModalResult')).toBeVisible();expect(runs.get('gps-range').redeem).toHaveLength(1);
  const attempt=runs.get('gps-range').redeem[0];expect(attempt.bookingId).toBe('00000000-0000-4000-8000-000000000001');
});


test('accessible receipt image fallback supports preview, discard, and one signed upload after camera denial',async({page})=>{
  const run='receipt-image-picker';
  await open(page,run,'camera-denied',true);
  await expect(page.locator('#bookingReceiptMessage')).toContainText('選擇收據圖片');
  const uploadFile={name:'receipt.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==','base64')};
  await page.locator('#bookingReceiptFile').setInputFiles(uploadFile);
  await expect(page.locator('#bookingReceiptPreview')).toHaveAttribute('src',/^data:image\/png/);
  await expect(page.locator('#bookingReceiptSubmit')).toBeEnabled();
  await page.locator('#bookingReceiptDiscard').click();
  await expect(page.locator('#bookingReceiptSubmit')).toBeDisabled();
  expect(runs.get(run).prepare).toHaveLength(0);
  await page.locator('#bookingReceiptFile').setInputFiles(uploadFile);
  await expect(page.locator('#bookingReceiptSubmit')).toBeEnabled();
  await page.locator('#bookingReceiptSubmit').click();
  await expect(page.locator('#bookingReceiptModal')).toBeHidden();
  const state=runs.get(run);
  expect(state.prepare).toHaveLength(1);
  expect(state.finalize).toHaveLength(1);
  expect(state.uploads).toHaveLength(1);
  expect(state.prepare[0].mimeType).toBe('image/png');
  expect(state.uploads[0].type).toBe('image/png');
  expect(state.status).toBe('awaiting_review');
});

test('invalid receipt images are rejected; cancel preserves all business records',async({page})=>{
  const run='receipt-file-invalid';
  await open(page,run,'camera-denied',true);
  await expect(page.locator('.app-shell')).toHaveAttribute('inert','');
  await page.locator('#bookingReceiptFile').setInputFiles({name:'bad.pdf',mimeType:'application/pdf',buffer:Buffer.from('not an image')});
  await expect(page.locator('#bookingReceiptMessage')).toContainText('JPG');
  await expect(page.locator('#bookingReceiptSubmit')).toBeDisabled();
  await page.locator('#bookingReceiptFile').setInputFiles({name:'huge.jpg',mimeType:'image/jpeg',buffer:Buffer.alloc(5*1024*1024+1,255)});
  await expect(page.locator('#bookingReceiptMessage')).toContainText('5 MB');
  await expect(page.locator('#bookingReceiptSubmit')).toBeDisabled();
  await page.locator('#bookingReceiptCancel').click();
  await expect(page.locator('#bookingReceiptModal')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/booking-receipt-modal-open/);
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert','');
  expect(runs.get(run).prepare).toHaveLength(0);
  expect(runs.get(run).finalize).toHaveLength(0);
  expect(runs.get(run).uploads).toHaveLength(0);
});

test('snapshot held ticket submits without any eligible booking and expired ticket stays disabled',async({page})=>{
 const run='snapshot-ticket-selection';await open(page,run,'tickets-required');await expect(page.locator('[data-snapshot-id="QA-TICKET"]')).toBeEnabled();
 await expect(page.locator('[data-snapshot-id="QA-EXPIRED"]')).toBeDisabled();await page.locator('[data-snapshot-id="QA-TICKET"]').check();
 await capture(page);await page.locator('#bookingReceiptSubmit').click();await expect(page.locator('#bookingReceiptModal')).toBeHidden();
 expect(runs.get(run).prepare[0]).toMatchObject({benefits:[{kind:'event',id:'QA-TICKET'}]});
  expect(runs.get(run).prepare[0].requestedBookingId).toBeUndefined();
});

test('snapshot ticket cards show selection feedback without a booking selector',async({page})=>{
  const run='snapshot-ticket-ui-cards';
  await open(page,run,'tickets-required');
  const available=page.locator('.snapshot-ticket-choice').filter({hasText:'QA held ticket'});
  const expired=page.locator('.snapshot-ticket-choice').filter({hasText:'Expired'});
  await expect(available).toBeVisible();
  await expect(available).toContainText('活動票券');
  await expect(available).toContainText('點選使用');
  await expect(expired).toHaveClass(/is-unavailable/);
  await expect(expired).toContainText('票券已過期');
  await expect(expired.locator('input[type="checkbox"]')).toBeDisabled();
  await expect(page.locator('#snapshotTicketSelectionSummary')).toContainText('無需事先預約');
  await expect(page.locator('#snapshotTicketBooking')).toHaveCount(0);
  await available.click();
  await expect(available).toHaveClass(/is-selected/);
  await expect(available).toContainText('已選擇');
  await expect(page.locator('#snapshotTicketSelectionSummary')).toContainText('已選擇 1 張票券');
  await expect(page.locator('#snapshotTicketBooking')).toHaveCount(0);
  await expect(page.locator('#snapshotTicketSelectionSummary')).toContainText('不需要事先預約');
  await available.click();
  await expect(available).not.toHaveClass(/is-selected/);
  await expect(page.locator('#snapshotTicketSelectionSummary')).toContainText('無需事先預約');
  await expect(page.locator('#snapshotTicketBooking')).toHaveCount(0);
  expect(runs.get(run).prepare).toHaveLength(0);
});

test('snapshot lists unclaimed event tickets and enables selection only after claiming with GPS',async({page})=>{
  const run='snapshot-unclaimed-event';
  await open(page,run,'unclaimed-event');
  const offer=page.locator('.snapshot-ticket-option').filter({hasText:'QA new event'});
  await expect(offer).toBeVisible();
  await expect(offer.locator('input[type="checkbox"]')).toBeDisabled();
  await expect(offer).toContainText('尚未領取');
  expect(runs.get(run).claimCalls).toHaveLength(0);
  await offer.locator('.snapshot-ticket-claim-button').click();
  await expect(page.locator('[data-snapshot-id="QA-NEW-CLAIM"]')).toBeEnabled();
  await expect(page.locator('.snapshot-ticket-claim-button')).toHaveCount(0);
  expect(runs.get(run).claimCalls).toEqual([{eventTicketId:'QA-UNCLAIMED'}]);
  await page.locator('[data-snapshot-id="QA-NEW-CLAIM"]').check();
  await expect(page.locator('#snapshotTicketSelectionSummary')).toContainText('已選擇 1 張票券');
  await capture(page);
  await page.locator('#bookingReceiptSubmit').click();
  await expect(page.locator('#bookingReceiptModal')).toBeHidden();
  expect(runs.get(run).prepare[0].benefits).toEqual([{kind:'event',id:'QA-NEW-CLAIM'}]);
});

test('snapshot blocks cumulative point overspend and configured ticket quantity limits',async({page})=>{
 const run='snapshot-point-limits';
 await open(page,run,'ticket-limits');
 const point1=page.locator('[data-snapshot-id="QA-P1"]');
 const point2=page.locator('[data-snapshot-id="QA-P2"]');
 const point3=page.locator('[data-snapshot-id="QA-P3"]');
 const point4=page.locator('[data-snapshot-id="QA-P4"]');
 const event1=page.locator('[data-snapshot-id="QA-E1"]');
 const event2=page.locator('[data-snapshot-id="QA-E2"]');
 await point1.check();
 await expect(point2).toBeDisabled();
 await expect(point2.locator('..')).toContainText('點數不足');
 await expect(point3).toBeEnabled();
 await point3.check();
 await expect(point4).toBeDisabled();
 await expect(point4.locator('..')).toContainText('單次上限 2 張');
 await expect(page.locator('#snapshotTicketSelectionSummary')).toContainText('A 卡預計扣 5 點');
 await event1.check();
 await expect(event2).toBeDisabled();
 await expect(event2.locator('..')).toContainText('每日上限 2 張');
 await point1.uncheck();
 await expect(point2).toBeEnabled();
 await expect(point4).toBeEnabled();
 await event1.uncheck();
 await expect(event2).toBeEnabled();
 await capture(page);
 await page.locator('#bookingReceiptSubmit').click();
 await expect(page.locator('#bookingReceiptModal')).toBeHidden();
 expect(runs.get(run).prepare[0].benefits).toEqual([{kind:'points',id:'QA-P3'}]);
});
