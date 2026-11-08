'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(base,file),'utf8');
const { workWindow, slotFitsClosingTime, timeOnBusinessDate } = require('../supabase/functions/_shared/booking-hours.ts');

test('AC-MIN-001/002: 0 forbids late ending; minutes cap is inclusive',()=>{
  const {start,end}=workWindow('09:00','19:00');
  assert.equal(slotFitsClosingTime(start,30,end,0),true);
  assert.equal(slotFitsClosingTime(18*60+30,60,end,0),false);
  assert.equal(slotFitsClosingTime(18*60+30,60,end,30),true);
  assert.equal(slotFitsClosingTime(18*60+30,61,end,30),false,'one minute over cap denied');
  assert.equal(slotFitsClosingTime(18*60+30,90,end,60),true);
  assert.equal(slotFitsClosingTime(end,30,end,1439),false,'no booking may start at closing');
  assert.equal(slotFitsClosingTime(end+30,30,end,1439),false);
  assert.equal(slotFitsClosingTime(start,1439,end,1439),true);
  assert.equal(slotFitsClosingTime(start,1440,end,1439),false,'storage max still 1439');
  assert.equal(slotFitsClosingTime(start,0,end,1439),false);
  assert.equal(slotFitsClosingTime(start,30.5,end,1439),false);
  for(const limit of [-1,1440,0.5,NaN,Infinity,undefined]) assert.equal(slotFitsClosingTime(start,30,end,limit),false,'invalid cap must fail closed: '+limit);
  assert.equal(timeOnBusinessDate('2026-12-31',18*60+30),'2026-12-31T18:30:00+08:00');
});

test('AC-MIN-003: overnight closing limit and single/multi time-source parity',()=>{
  const {start,end,overnight}=workWindow('14:00','02:00');
  assert.equal(overnight,true);
  assert.equal(slotFitsClosingTime(start,60,end,0),true);
  assert.equal(slotFitsClosingTime(25*60+30,90,end,0),false);
  assert.equal(slotFitsClosingTime(25*60+30,90,end,30),false);
  assert.equal(slotFitsClosingTime(25*60+30,90,end,60),true);
  assert.equal(slotFitsClosingTime(end,30,end,1439),false);
  assert.equal(slotFitsClosingTime(23*60+50+1440,60,2875,1439),false,'two-day timestamp ceiling remains');
  assert.equal(timeOnBusinessDate('2026-12-31',25*60+30),'2027-01-01T01:30:00+08:00');
  for(const file of ['booking-api/index.ts','booking-group-api/index.ts','booking-group-slots-api/index.ts']){
    const source=read('supabase/functions/'+file);
    assert.match(source,/slotFitsClosingTime\((?:cursor|start),\s*(?:duration|g\.duration|group\.totalDurationMinutes),\s*workEnd,\s*Number\((?:settings|cfg|group\.settings)\.max_end_overrun_minutes \?\? 0\)\)/);
    assert.doesNotMatch(source,/slotFitsClosingTime\([^\n]+allow_end_overrun/);
  }
});

test('AC-MIN-004/005: numeric admin field, dirty draft, save and readback',()=>{
  const admin=read('admin/booking-panel-core.js');
  const edge=read('supabase/functions/booking-admin-api/index.ts');
  assert.match(admin,/id="bookingAdminMaxEndOverrunMinutes" type="number" min="0" max="1439" step="1"/);
  assert.doesNotMatch(admin,/id="bookingAdminAllowEndOverrun"/);
  assert.match(admin,/SETTINGS_INPUT_IDS.*bookingAdminMaxEndOverrunMinutes/);
  assert.match(admin,/bookingAdminMaxEndOverrunMinutes\.value = String\(settings\.maxEndOverrunMinutes \?\? 0\)/);
  assert.match(admin,/maxEndOverrunMinutes,/);
  assert.match(admin,/Number\.isInteger\(maxEndOverrunMinutes\)/);
  assert.match(edge,/maxEndOverrunMinutes: Number\(row\?\.max_end_overrun_minutes \?\? 0\)/);
  assert.match(edge,/INVALID_BOOKING_END_OVERRUN_MINUTES/);
  assert.match(edge,/save_booking_shared_settings_v10/);
  assert.match(edge,/p_max_end_overrun_minutes: body\.maxEndOverrunMinutes \?\? null/);
});

test('AC-MIN-006/007/008: tenant migration, server guard, safe default and service-only RPC',()=>{
  const sql=read('supabase/migrations/20261108210000_booking_end_overrun_minutes.sql');
  assert.match(sql,/max_end_overrun_minutes integer not null default 0/);
  assert.match(sql,/max_end_overrun_minutes between 0 and 1439/);
  assert.match(sql,/update public\.booking_settings set max_end_overrun_minutes = 1439 where allow_end_overrun = true/);
  assert.match(sql,/booking_slot_fits[\s\S]*?max_end_overrun_minutes/);
  assert.match(sql,/save_booking_shared_settings_v10[\s\S]*?p_max_end_overrun_minutes integer/);
  assert.match(sql,/save_booking_shared_settings_v9\(/);
  assert.match(sql,/BOOKING_END_OVERRUN_MINUTES_UPDATED/);
  assert.match(sql,/platform_private\.install_booking_end_overrun_minutes/);
  assert.match(sql,/platform_provision_business_before_booking_end_overrun_minutes/);
  assert.match(sql,/grant execute on function public\.save_booking_shared_settings_v10[\s\S]*?to service_role/);
});
