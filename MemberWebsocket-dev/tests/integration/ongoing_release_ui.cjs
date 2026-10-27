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
test('retired operation-audit renderer is absent while database audit RPC is permission-restricted',()=>{
 const html=source('admin/index.html');
 const api=source('supabase/functions/api/index.ts');
 const sql=source('supabase/migrations/20261013043627_member_booking_selections_and_audit_query.sql');
 assert.equal(fs.existsSync(path.join(root,'admin/operation-audit.js')),false);
 assert.equal(fs.existsSync(path.join(root,'admin/operation-audit.css')),false);
 assert.doesNotMatch(html,/operation-audit\\.(?:js|css)/);
 assert.doesNotMatch(api,/if \\(action === "admin\\.audit\\.query"\\)/);
 assert.match(api,/supabase\\.from\\("audit_logs"\\)\\.insert/);
 assert.match(sql,/revoke all on function public\\.admin_query_operation_audit\\([^;]+\\) from public,anon,authenticated;/i);
 assert.match(sql,/grant execute on function public\\.admin_query_operation_audit\\([^;]+\\) to service_role;/i);
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
