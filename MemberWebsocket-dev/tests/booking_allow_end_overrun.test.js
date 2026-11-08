'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(base,file),'utf8');
const { workWindow, slotFitsClosingTime, timeOnBusinessDate } = require('../supabase/functions/_shared/booking-hours.ts');

test('AC-001/002: the closing policy changes finish time only, never start eligibility',()=>{
  const {start,end}=workWindow('09:00','19:00');
  assert.equal(slotFitsClosingTime(start,30,end,false),true);
  assert.equal(slotFitsClosingTime(18*60+30,60,end,false),false);
  assert.equal(slotFitsClosingTime(18*60+30,60,end,true),true);
  assert.equal(slotFitsClosingTime(start,1440,end,true),false,'a 1440-minute selection cannot be persisted');
  assert.equal(slotFitsClosingTime(start,1439,end,true),true,'1439 minutes is accepted by the shared contract');
  assert.equal(slotFitsClosingTime(start,0,end,true),false);
  assert.equal(slotFitsClosingTime(start,30.5,end,true),false);
  assert.equal(slotFitsClosingTime(end,30,end,true),false);
  assert.equal(slotFitsClosingTime(end+30,30,end,true),false);
  assert.equal(timeOnBusinessDate('2026-12-31',18*60+30),'2026-12-31T18:30:00+08:00');
});

test('AC-004: midnight shift preserves original business date and single/multiple-booking parity',()=>{
  const {start,end,overnight}=workWindow('14:00','02:00');
  assert.equal(overnight,true);
  assert.equal(slotFitsClosingTime(start,60,end,false),true);
  assert.equal(slotFitsClosingTime(25*60+30,90,end,false),false);
  assert.equal(slotFitsClosingTime(25*60+30,90,end,true),true);
  assert.equal(slotFitsClosingTime(end,30,end,true),false);
  assert.equal(slotFitsClosingTime(23*60+50+1440,60,2875,true),false,'offset beyond next-day timestamp capacity is denied');
  assert.equal(timeOnBusinessDate('2026-12-31',25*60+30),'2027-01-01T01:30:00+08:00');
  const sources=[
    read('supabase/functions/booking-api/index.ts'),
    read('supabase/functions/booking-group-api/index.ts'),
    read('supabase/functions/booking-group-slots-api/index.ts')
  ];
  for(const source of sources){
    assert.match(source,/slotFitsClosingTime\((?:cursor|start),\s*(?:duration|g\.duration|group\.totalDurationMinutes),\s*workEnd,\s*(?:settings|cfg|group\.settings)\.allow_end_overrun === true\)/);
  }
});

test('AC-003/006: admin setting is accessible, draft-protected, saved as boolean and read back',()=>{
  const admin=read('admin/booking-panel-core.js');
  const edge=read('supabase/functions/booking-admin-api/index.ts');
  assert.match(admin,/id="bookingAdminAllowEndOverrun" type="checkbox"/);
  assert.match(admin,/bookingAdminAllowEndOverrun.*SETTINGS_INPUT_IDS|SETTINGS_INPUT_IDS.*bookingAdminAllowEndOverrun/s);
  assert.match(admin,/bookingAdminAllowEndOverrun\.checked = settings\.allowEndOverrun === true/);
  assert.match(admin,/allowEndOverrun: els\.bookingAdminAllowEndOverrun\.checked/);
  assert.match(edge,/allowEndOverrun: row\?\.allow_end_overrun === true/);
  assert.match(edge,/body\.allowEndOverrun !== undefined && typeof body\.allowEndOverrun !== "boolean"/);
  assert.match(edge,/save_booking_shared_settings_v9/);
  assert.match(edge,/p_allow_end_overrun: body\.allowEndOverrun \?\? null/);
});

test('AC-005: tenant installer, fail-closed migration and secured RPC are required',()=>{
  const sql=read('supabase/migrations/20261108173000_booking_allow_end_overrun.sql');
  assert.match(sql,/allow_end_overrun boolean not null default false/);
  assert.match(sql,/booking_slot_fits[\s\S]*?language sql stable/);
  assert.match(sql,/save_booking_shared_settings_v9[\s\S]*?p_allow_end_overrun boolean/);
  assert.match(sql,/save_booking_shared_settings_v8\(/);
  assert.match(sql,/BOOKING_END_OVERRUN_POLICY_UPDATED/);
  assert.match(sql,/platform_private\.install_booking_end_overrun/);
  assert.match(sql,/platform_provision_business_before_booking_end_overrun/);
  assert.match(sql,/grant execute on function public\.save_booking_shared_settings_v9[\s\S]*?to service_role/);
});
