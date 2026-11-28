'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname,'..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');

function calendarHarness() {
  const source=read('booking/calendar-flow.js');
  const instrumented=source.replace(/\}\)\(\);\s*$/, 'window.__rangeTest={state,els,updateDayAction};\n})();');
  const window={addEventListener(){},BookingSystem:{formatDate:d=>d}};
  vm.runInNewContext(instrumented,{window,document:{},HTMLElement:class{}});
  const h=window.__rangeTest;
  Object.assign(h.state,{
    today:'2026-11-28', minimumDate:'2026-11-30', maximumDate:'2026-12-28',
    minAdvanceDays:2, maxAdvanceDays:30, phoneBookingNumber:'',
    outOfRangeNotice:'', holidayNotice:'', holidaysByDate:new Map()
  });
  h.els.startDayBookingButton={disabled:false,hidden:false};
  h.els.bookingDayHint={textContent:''};
  h.els.bookingDayOutOfRangeNotice={hidden:true,textContent:''};
  h.els.bookingDayHolidayNotice={hidden:true,textContent:''};
  h.els.bookingDayHolidayDetails={hidden:true,replaceChildren(){}};
  h.els.bookingPhoneFallback={hidden:true};
  h.els.bookingPhoneDial={textContent:'',href:'',setAttribute(){},removeAttribute(name){delete this[name];}};
  return h;
}
function show(h,date) {h.state.historyDate=date;h.updateDayAction();return h.els;}
test('AC-RANGE-001: only beyond the admin booking horizon shows a range notice',()=>{
  const h=calendarHarness();
  for(const date of ['2026-11-27','2026-11-28','2026-11-29']){
    const els=show(h,date);
    assert.equal(els.startDayBookingButton.hidden,true,date);
    assert.equal(els.startDayBookingButton.disabled,true,date);
    assert.equal(els.bookingDayOutOfRangeNotice.hidden,true,date);
    assert.equal(els.bookingDayOutOfRangeNotice.textContent,'',date);
  }
  const outside=show(h,'2026-12-29');
  assert.equal(outside.startDayBookingButton.hidden,true);
  assert.equal(outside.startDayBookingButton.disabled,true);
  assert.equal(outside.bookingDayOutOfRangeNotice.hidden,false);
  assert.match(outside.bookingDayOutOfRangeNotice.textContent,/線上預約/);
  assert.equal(outside.bookingDayHolidayNotice.hidden,true);
  for(const date of ['2026-11-30','2026-12-28']){
    const els=show(h,date);
    assert.equal(els.startDayBookingButton.hidden,false,date);
    assert.equal(els.startDayBookingButton.disabled,false,date);
    assert.equal(els.bookingDayOutOfRangeNotice.hidden,true,date);
    assert.equal(els.bookingDayOutOfRangeNotice.textContent,'',date);
  }
});
test('AC-RANGE-002: admin-configured multiline or HTML-like text is shown literally; holiday priority remains',()=>{
  const h=calendarHarness();
  const custom='已截止線上預約。\n請來電 <img src=x onerror=alert(1)>';
  h.state.outOfRangeNotice=custom;
  let els=show(h,'2026-12-29');
  assert.equal(els.bookingDayOutOfRangeNotice.textContent,custom);
  h.state.holidaysByDate.set('2026-12-29',[{title:'技師休假'}]);
  // This test covers footer prioritization; the holiday details DOM has its own dedicated tests.
  h.els.bookingDayHolidayDetails = null;
  els=show(h,'2026-12-29');
  assert.equal(els.bookingDayOutOfRangeNotice.hidden,true);
  assert.equal(els.bookingDayOutOfRangeNotice.textContent,'');
  assert.equal(els.bookingDayHolidayNotice.hidden,false);
});
test('AC-RANGE-003: lead-time phone fallback remains available while online button is hidden',()=>{
  const h=calendarHarness();
  h.state.phoneBookingNumber='06-1234567';
  const els=show(h,'2026-11-29');
  assert.equal(els.startDayBookingButton.hidden,true);
  assert.equal(els.bookingPhoneFallback.hidden,false);
  assert.equal(els.bookingDayOutOfRangeNotice.hidden,true);
  assert.equal(els.bookingDayOutOfRangeNotice.textContent,'');
});
test('AC-RANGE-004: owner-scoped admin message, CAS, validation, older-client preservation, calendar read',()=>{
  const admin=read('admin/booking-panel-core.js');
  const api=read('supabase/functions/booking-admin-api/index.ts');
  const memberApi=read('supabase/functions/booking-calendar-api/index.ts');
  const migration=read('supabase/migrations/20261128220000_booking_out_of_range_notice.sql');
  assert.match(admin,/id="bookingAdminOutOfRangeNotice" maxlength="400"/);
  assert.match(admin,/outOfRangeNotice: String\(els\.bookingAdminOutOfRangeNotice\.value/);
  assert.match(admin,/els\.bookingAdminOutOfRangeNotice\.value = String\(settings\.outOfRangeNotice/);
  assert.match(api,/outOfRangeNotice: String\(row\?\.out_of_range_notice/);
  assert.match(api,/hasOutOfRangeNotice = Object\.prototype\.hasOwnProperty\.call\(body, "outOfRangeNotice"\)/);
  assert.match(api,/typeof body\.outOfRangeNotice !== "string"/);
  assert.match(api,/out_of_range_notice: outOfRangeNotice/);
  assert.match(api,/\.eq\("id", 1\)\.eq\("updated_at", expectedUpdatedAt\)/);
  assert.match(memberApi,/out_of_range_notice/);
  assert.match(memberApi,/outOfRangeNotice/);
  assert.match(migration,/platform_private\.tenants/);
  assert.match(migration,/platform_private\.business_templates/);
  assert.match(migration,/char_length\(out_of_range_notice\) <= 400/);
});
test('AC-RANGE-005: semantic footer and separate accessible palette; versioned assets',()=>{
  const page=read('booking/index.html');
  const css=read('booking/calendar-flow.css');
  const member=read('booking/calendar-flow.js');
  assert.match(page,/id="bookingDayOutOfRangeNotice"[^>]*role="status"/);
  assert.match(css,/\.booking-day-out-of-range-notice/);
  assert.match(css,/html\[data-theme="dark"\] .booking-day-footer .booking-day-out-of-range-notice/);
  assert.match(css,/white-space: pre-wrap/);
  assert.match(page,/calendar-flow\.js\?v=[^"']+out-of-range-notice=20261128-2/);
  assert.match(page,/calendar-flow\.css\?v=[^"']+out-of-range-notice=20261128-1/);
  assert.match(member,/state\.outOfRangeNotice = '';/);
});

test('AC-RANGE-006: unlimited maximum booking days never shows a horizon notice',()=>{
  const h=calendarHarness();
  h.state.maxAdvanceDays=0;
  h.state.maximumDate='';
  for(const date of ['2026-11-27','2026-11-29','2027-08-19']){
    const els=show(h,date);
    assert.equal(els.bookingDayOutOfRangeNotice.hidden,true,date);
    assert.equal(els.bookingDayOutOfRangeNotice.textContent,'',date);
  }
});
test('AC-RANGE-007: beyond maximum has no phone fallback, even if number is configured',()=>{
  const h=calendarHarness();
  h.state.phoneBookingNumber='06-1234567';
  const els=show(h,'2026-12-29');
  assert.equal(els.startDayBookingButton.hidden,true);
  assert.equal(els.bookingPhoneFallback.hidden,true);
  assert.equal(els.bookingDayOutOfRangeNotice.hidden,false);
});
