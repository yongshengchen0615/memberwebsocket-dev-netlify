const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const { setImmediate: nextTurn } = require('node:timers/promises');
const fs = require('./helpers/edge-test-fs.cjs');
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
    uuid: (value) => String(value),
    ApiError: class ApiError extends Error {
      constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
      }
    },
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
    slotFitsClosingTime: hours.slotFitsClosingTime,
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
  const builder = { select() { return this; }, eq() { return this; }, gte() { return this; }, lte() { return this; }, in() { return this; }, like() { return this; },
    then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); } };
  const supabase = { from() { return builder; } };
  const result = await buildSlots()(supabase, null, { bookingDate: '2026-10-01' });
  assert.equal(result.earliestBookingDate, range.earliestBookingDate);
  assert.equal(result.latestBookingDate, range.latestBookingDate);
  assert.ok(result.slots.length > 0);
});

test('optional onsite booking does not reserve or collide with an unselected primary technician', async () => {
  const optional={...group,settings:{...group.settings,require_primary_technician:false}};
  const builder={select(){return this;},gte(){return this;},lte(){return this;},like(){return this;},in(){return this;},then(resolve){return Promise.resolve({data:[],error:null}).then(resolve);}};
  const supabase={from(table){assert.equal(table,'bookings','only non-technician phone occupancy may be queried');return builder;}};
  const result=await buildSlots(false,optional)(supabase,null,{bookingDate:'2026-10-01'});
  assert.ok(result.slots.length>0);
  assert.ok(result.slots.every(slot=>slot.available));
  assert.equal(result.settings.requirePrimaryTechnician,false);
});

test('AC-007: group member slots grey out telephone reservations even without a technician', async () => {
  const optional={...group,settings:{...group.settings,require_primary_technician:false}};
  const bookingDate='2026-10-01';
  const phone={id:'phone-1',start_at:'2026-10-01T09:30:00+08:00',end_at:'2026-10-01T10:00:00+08:00'};
  const builder={
    select(){return this;},gte(){return this;},lte(){return this;},like(field,value){
      assert.equal(field,'request_id');assert.equal(value,'PHONE-%');return this;},
    in(field,value){assert.equal(field,'status');assert.equal(value.join(','),'pending,confirmed');return this;},
    then(resolve){return Promise.resolve({data:[phone],error:null}).then(resolve);}
  };
  const result=await buildSlots(false,optional)({from(table){assert.equal(table,'bookings');return builder;}},null,{bookingDate});
  assert.equal(result.slots.find(slot=>slot.startTime==='09:00').available,true);
  assert.equal(result.slots.find(slot=>slot.startTime==='09:30').available,false);
  assert.equal(result.slots.find(slot=>slot.startTime==='09:30').unavailableReason,'occupied');
});

test('overnight slots carry the prior business date and reject midnight overlap', async () => {
  const bookingDate = '2026-09-30';
  const overnight = { ...group, settings: { ...group.settings, work_start_time: '14:00:00', work_end_time: '02:00:00', slot_interval_minutes: 15 } };
  const occupied = { id: 'another-booking', start_at: '2026-10-01T00:15:00', end_at: '2026-10-01T01:15:00' };
  const builder = { select() { return this; }, eq() { return this; }, gte() { return this; }, lte() { return this; }, in() { return this; }, like() { return this; },
    then(resolve) { return Promise.resolve({ data: [occupied], error: null }).then(resolve); } };
  const result = await buildSlots(false, overnight)({ from() { return builder; } }, null, { bookingDate });
  const midnight = result.slots.find((slot) => slot.startTime === '00:30');
  assert.equal(midnight.startAt, '2026-10-01T00:30:00+08:00');
  assert.equal(midnight.endAt, '2026-10-01T01:00:00+08:00');
  assert.equal(midnight.available, false);
  assert.equal(result.slots.find((slot) => slot.startTime === '01:30').available, true);
  assert.equal(result.slots.some((slot) => slot.startTime === '01:45'), false);
});

const assignedGroup = {
  ...group,
  settings: { ...group.settings, work_end_time: '11:30:00' },
  assignments: [{ technicianId: group.primaryId, durationMinutes: 30 }],
};
const bookingDate = '2026-10-01';
const member = { id: 'member-1' };
const readKinds = ['legacy', 'phone', 'participant'];

function occupancyDatabase(results = {}) {
  const requests = [];
  return { requests, from(table) {
    const filters = [];
    let kind = table === 'booking_participant_reservations' ? 'participant' : 'legacy';
    const query = {
      select() { return this; },
      eq(field, value) { filters.push([field, value]); return this; },
      gte(field, value) { filters.push([field, value]); return this; },
      lte(field, value) { filters.push([field, value]); return this; },
      in(field, value) { filters.push([field, Array.from(value)]); return this; },
      like(field, value) { kind = 'phone'; filters.push([field, value]); return this; },
      maybeSingle() { kind = 'edit'; return this; },
      then(resolve, reject) {
        requests.push({ kind, filters });
        return Promise.resolve(results[kind] ?? { data: [], error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
}

function occupiedAt(id, start, end, extra = {}) {
  return { id, start_at: `${bookingDate}T${start}:00+08:00`, end_at: `${bookingDate}T${end}:00+08:00`, ...extra };
}

test('AC-001: group availability starts all independent occupancy reads before any can finish', async () => {
  const pending = Object.fromEntries(readKinds.map((kind) => [kind, Promise.withResolvers()]));
  const db = occupancyDatabase(Object.fromEntries(readKinds.map((kind) => [kind, pending[kind].promise])));
  let responded = false;
  const operation = buildSlots(false, assignedGroup)(db, member, { bookingDate }).then((result) => {
    responded = true;
    return result;
  });
  await nextTurn();
  const startedBeforeAnyResponse = db.requests.map(({ kind }) => kind).sort();
  pending.phone.resolve({ data: [occupiedAt('phone', '09:30', '10:00')], error: null });
  pending.participant.resolve({ data: [], error: null });
  await nextTurn();
  const respondedBeforeLastRead = responded;
  pending.legacy.resolve({ data: [], error: null });
  const result = await operation;

  assert.deepEqual(startedBeforeAnyResponse, [...readKinds].sort());
  assert.equal(respondedBeforeLastRead, false);
  assert.equal(db.requests.length, 3);
  assert.equal(result.slots.find((slot) => slot.startTime === '09:30').available, false);
});

test('AC-002: group availability preserves each occupancy filter and excludes only the owned edit', async () => {
  const bookingId = 'edit-booking';
  const db = occupancyDatabase({
    edit: { data: { id: bookingId, status: 'confirmed' }, error: null },
    legacy: { data: [occupiedAt('legacy', '09:00', '09:30'), occupiedAt(bookingId, '10:30', '11:00')], error: null },
    phone: { data: [occupiedAt('phone', '09:30', '10:00')], error: null },
    participant: { data: [
      occupiedAt('reservation', '10:00', '10:30', { booking_id: 'other-booking', technician_id: group.primaryId }),
      occupiedAt('edited-reservation', '10:30', '11:00', { booking_id: bookingId, technician_id: group.primaryId }),
    ], error: null },
  });
  const result = await buildSlots(false, assignedGroup)(db, member, { bookingDate, bookingId });
  assert.deepEqual(db.requests[0], { kind: 'edit', filters: [['id', bookingId], ['member_id', member.id]] });
  const dateFilters = [['booking_date', '2026-09-30'], ['booking_date', '2026-10-02']];
  const activeStatus = ['status', ['pending', 'confirmed']];
  for (const { kind, filters } of db.requests.slice(1)) {
    switch (kind) {
      case 'legacy': assert.deepEqual(filters, [...dateFilters, ['technician_id', [group.primaryId]], ['party_size', 1], activeStatus]); break;
      case 'phone': assert.deepEqual(filters, [...dateFilters, ['request_id', 'PHONE-%'], activeStatus]); break;
      case 'participant': assert.deepEqual(filters, [...dateFilters, ['is_active', true], ['technician_id', [group.primaryId]]]); break;
      default: assert.fail(`Unexpected query: ${kind}`);
    }
  }
  assert.deepEqual(Array.from(result.slots, (slot) => [slot.startTime, slot.available, slot.unavailableReason]), [
    ['09:00', false, 'occupied'], ['09:30', false, 'occupied'], ['10:00', false, 'occupied'],
    ['10:30', true, null], ['11:00', true, null],
  ]);
});

test('AC-002: onsite arrangements without a selected technician only query phone occupancy', async () => {
  const onsite = { ...group, settings: { ...group.settings, require_primary_technician: false } };
  const db = occupancyDatabase();
  await buildSlots(false, onsite)(db, member, { bookingDate });
  assert.deepEqual(db.requests.map(({ kind }) => kind), ['phone']);
});

test('AC-003: group availability waits for edit ownership and rejects inaccessible or closed edits', async () => {
  for (const data of [null, { status: 'cancelled' }]) {
    const edit = Promise.withResolvers();
    const db = occupancyDatabase({ edit: edit.promise });
    const operation = buildSlots(false, assignedGroup)(db, member, { bookingDate, bookingId: 'uneditable' });
    await nextTurn();
    const startedBeforeAuthorization = db.requests.map(({ kind }) => kind);
    edit.resolve({ data, error: null });
    await assert.rejects(operation, { status: 409, code: 'BOOKING_NOT_EDITABLE' });
    assert.deepEqual(startedBeforeAuthorization, ['edit']);
    assert.equal(db.requests.length, 1);
  }
});

test('AC-003: each occupancy lookup failure preserves the database error and blocks the result', async () => {
  for (const [kind, message] of [
    ['legacy', '無法讀取主要技師時段。'],
    ['phone', '無法確認電話預約佔用時段。'],
    ['participant', '無法讀取技師預約時段。'],
  ]) {
    const db = occupancyDatabase({ [kind]: { data: null, error: { message: 'database unavailable' } } });
    await assert.rejects(buildSlots(false, assignedGroup)(db, member, { bookingDate }), { status: 500, code: 'DATABASE_ERROR', message });
  }
});
