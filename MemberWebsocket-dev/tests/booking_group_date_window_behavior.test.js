const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const hours = require('../supabase/functions/_shared/booking-hours.ts');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/booking-group-slots-api/index.ts'), 'utf8');
const slotSource = stripTypeScriptTypes(source.slice(
  source.indexOf('async function slots('), source.indexOf('\nDeno.serve(', source.indexOf('async function slots('))
));
const today = '2026-09-24';
const group = {
  settings: {
    min_advance_days: 4, max_advance_days: 33, max_party_size: 2,
    work_start_time: '09:00:00', work_end_time: '10:00:00'
  },
  primaryId: 'primary-technician', assignments: [], totalDurationMinutes: 30, totalAmount: 0
};

function buildSlots(holiday = false, configuredGroup = group) {
  const context = {
    normalizeGroup: async () => configuredGroup,
    SLOT_INTERVAL: 30,
    dateValue: (value) => String(value),
    taipeiDate: () => today,
    taipeiMinutes: () => 0,
    addDays: (date, days) => {
      const value = new Date(date + 'T00:00:00Z');
      value.setUTCDate(value.getUTCDate() + days);
      return value.toISOString().slice(0, 10);
    },
    isActiveBookingHoliday: async () => holiday,
    toMinutes: (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)),
    toTime: (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`,
    workWindow: hours.workWindow,
    currentBusinessDate: hours.currentBusinessDate,
    clockTime: hours.clockTime,
    occupiedRange: hours.occupiedRange,
    localRange: hours.localRange,
    slotHasPassed: (date, start) => hours.slotHasPassed(date, start, Date.parse('2026-09-24T00:00:00+08:00')),
    timeOnBusinessDate: hours.timeOnBusinessDate,
  };
  return vm.runInNewContext(slotSource + '\nslots', context);
}

const range = { earliestBookingDate: '2026-09-28', latestBookingDate: '2026-10-27' };

test('group slots return both booking date limits when too early or too far', async () => {
  const slots = buildSlots();
  for (const date of ['2026-09-27', '2026-10-28']) {
    const result = await slots(null, null, { bookingDate: date });
    assert.equal(result.earliestBookingDate, range.earliestBookingDate);
    assert.equal(result.latestBookingDate, range.latestBookingDate);
    assert.equal(result.slots.length, 0);
  }
});

test('group slots retain booking limits for a holiday', async () => {
  const result = await buildSlots(true)(null, null, { bookingDate: '2026-10-01' });
  assert.equal(result.holidayBlocked, true);
  assert.equal(result.earliestBookingDate, range.earliestBookingDate);
  assert.equal(result.latestBookingDate, range.latestBookingDate);
  assert.equal(result.slots.length, 0);
});

test('group slots retain booking limits on a normally available date', async () => {
  const builder = { select() { return this; }, eq() { return this; }, gte() { return this; }, lte() { return this; }, in() { return this; },
    then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); } };
  const supabase = { from() { return builder; } };
  const result = await buildSlots()(supabase, null, { bookingDate: '2026-10-01' });
  assert.equal(result.earliestBookingDate, range.earliestBookingDate);
  assert.equal(result.latestBookingDate, range.latestBookingDate);
  assert.ok(result.slots.length > 0);
});

test('optional onsite booking does not reserve or collide with an unselected primary technician', async () => {
  const optional={...group,settings:{...group.settings,require_primary_technician:false}};
  const result=await buildSlots(false,optional)({from(){throw new Error('No technician was selected');}},null,{bookingDate:'2026-10-01'});
  assert.ok(result.slots.length>0);
  assert.ok(result.slots.every(slot=>slot.available));
  assert.equal(result.settings.requirePrimaryTechnician,false);
});

test('overnight slots carry the prior business date and reject midnight overlap', async () => {
  const bookingDate = '2026-09-30';
  const overnight = { ...group, settings: { ...group.settings, work_start_time: '14:00:00', work_end_time: '02:00:00', slot_interval_minutes: 15 } };
  const occupied = { id: 'another-booking', start_at: '2026-10-01T00:15:00', end_at: '2026-10-01T01:15:00' };
  const builder = { select() { return this; }, eq() { return this; }, gte() { return this; }, lte() { return this; }, in() { return this; },
    then(resolve) { return Promise.resolve({ data: [occupied], error: null }).then(resolve); } };
  const result = await buildSlots(false, overnight)({ from() { return builder; } }, null, { bookingDate });
  const midnight = result.slots.find((slot) => slot.startTime === '00:30');
  assert.equal(midnight.startAt, '2026-10-01T00:30:00+08:00');
  assert.equal(midnight.endAt, '2026-10-01T01:00:00+08:00');
  assert.equal(midnight.available, false);
  assert.equal(result.slots.find((slot) => slot.startTime === '01:30').available, true);
  assert.equal(result.slots.some((slot) => slot.startTime === '01:45'), false);
});
