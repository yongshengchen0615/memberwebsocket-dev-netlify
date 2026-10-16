const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../..'),source=p=>fs.readFileSync(path.join(root,p),'utf8');
test('member history renders inside the card without a nested details toggle and remains read-only',()=>{
 const dom=new JSDOM(source('booking/index.html'),{url:'https://example.test/booking/?bookingId=FOREIGN',runScripts:'outside-only'}),w=dom.window;
 const add=w.addEventListener.bind(w);w.addEventListener=(type,...args)=>{if(type!=='DOMContentLoaded')add(type,...args);};
 w.BookingSystem={formatDate:x=>x};w.BookingGroupUI={};
 w.eval(source('booking/app.js').replace("  window.addEventListener('DOMContentLoaded',", "  window.__view={renderBookings,bookingMemberChatText,state,els};\n  window.addEventListener('DOMContentLoaded',"));
 const {renderBookings,bookingMemberChatText,state,els}=w.__view;for(const el of w.document.querySelectorAll('[id]'))els[el.id]=el;
 const booking={bookingId:'OWNED',bookingDate:'2026-10-15',startTime:'10:00',endTime:'11:00',startAt:'2026-10-15T10:00',endAt:'2026-10-15T11:00',status:'cancelled',items:[{serviceTitle:'我的服務',quantity:1,unitDurationMinutes:60,unitPriceAmount:100}],benefits:[{kind:'points',title:'本次票券',status:'cancelled'}],totalDurationMinutes:60,totalAmount:100,memberNote:'我的備註'};
 state.data={bookings:[booking],settings:{}};state.config={bookingLiffId:'2010787602-sgiB0ETj'};
 try{
  renderBookings();const item=w.document.querySelector('[data-booking-id="OWNED"]');assert.ok(item);assert.equal(item.querySelector('details.member-booking-details'),null);assert.match(item.querySelector('.booking-service-items')?.textContent || '',/我的服務/);assert.ok(item.textContent.includes('我的備註'));assert.equal(w.document.querySelector('[data-booking-id="FOREIGN"]'),null);
  const before=JSON.stringify(state.data);assert.ok(item.querySelector('.member-booking-format-totals'));assert.equal(JSON.stringify(state.data),before);
  const chat=bookingMemberChatText(booking);assert.doesNotMatch(chat,/營業日|我的備註/);assert.match(chat,/預約日期：2026-10-15/);assert.match(chat,/10:00/);assert.match(chat,/查看預約明細/);
 }finally{dom.window.close();}
});
test('readable audit handles legacy and malformed values without raw payload exposure',()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only'}),w=dom.window;
 w.eval(source('admin/operation-audit.js').replace('  function date(offset)', '  window.__audit={renderItem};\n  function date(offset)'));
 try{
  const row=w.__audit.renderItem({action:'user.pointcard.transfer',result:'success',actorRole:'member',actor:'M…001',targetType:'point_transfer',target:'PT-123',createdAt:'invalid',detail:{amount:5,sender:'甲…001',receiver:'乙…002',cardTitle:'集點卡',token:'DO-NOT-EXPOSE',nested:{password:'SECRET'}}});
  assert.match(row.textContent,/點數轉贈 · 成功/);assert.match(row.textContent,/转|轉入會員/);assert.match(row.textContent,/5 點/);assert.doesNotMatch(row.textContent,/DO-NOT-EXPOSE|SECRET|\{\"|undefined|\[object Object\]/);assert.equal(row.querySelector('pre'),null);
  const profile=w.__audit.renderItem({action:'MEMBER_PROFILE_UPDATED',result:'success',detail:{profileFields:['surname','token','phone']}});assert.match(profile.textContent,/姓氏、電話/);assert.doesNotMatch(profile.textContent,/token/);
  const legacy=w.__audit.renderItem({action:'SOMETHING_UNKNOWN',detail:'raw secret'});assert.match(legacy.textContent,/其他操作/);assert.doesNotMatch(legacy.textContent,/raw secret/);
 }finally{dom.window.close();}
});
test('no-show frontend uses Taipei end time and rejects snapshot, missing time, future and pending cancellation',()=>{
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only',url:'https://example.test/admin/'}),w=dom.window;
 const add=w.addEventListener.bind(w);w.addEventListener=(type,...args)=>{if(type!=='DOMContentLoaded')add(type,...args);};
 w.eval(source('admin/booking-panel-core.js').replace('  async function updateBookingStatus(', '  window.__noShow={noShowUnavailableReason};\n  async function updateBookingStatus('));
 try{
  const check=w.__noShow.noShowUnavailableReason;assert.equal(check({status:'pending',endAt:'2000-01-01T10:00:00'}),'');
  assert.match(check({status:'pending',endAt:'2999-01-01T10:00:00'}),/服務結束/);
  assert.match(check({status:'pending'}),/有效服務結束時間/);
  assert.match(check({status:'pending',receiptSubmissionId:'BR-1'}),/快照/);
  assert.match(check({status:'pending',cancellationRequestedAt:'now'}),/取消申請/);
 }finally{dom.window.close();}
});
