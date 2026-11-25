const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

const root = path.resolve(__dirname, '..');
const future = '2026-11-26T10:00:00+08:00';
const nowText = '2026-11-25T09:00:00+08:00';
class FixedDate extends Date {
  static now() { return Date.parse(nowText); }
}
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const settings = Object.freeze({
  work_start_time: '09:00:00',
  work_end_time: '17:00:00',
  min_advance_days: 1,
  onsite_edit_message: '請到店處理修改。',
});
const currentDate = '2026-11-25';
const original = {
  booking_date: '2026-11-25', start_at: '2026-11-25T10:00:00+08:00',
  status: 'confirmed', cancellation_requested_at: null, cancellation_reviewed_at: null,
};

function loadGuard(file, until) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const start = src.indexOf('function assertOriginalBookingOnlineEditable(');
  const end = src.indexOf(until, start);
  assert.ok(start >= 0 && end > start, 'server guard source must exist: ' + file);
  const scope = vm.createContext({
    ApiError, Date: FixedDate, Number, String,
    taipeiDate: () => currentDate, taipeiMinutes: () => 9 * 60,
    currentBusinessDate: () => currentDate,
    addDays: (day, count) => {
      const d = new Date(day + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + count);
      return d.toISOString().slice(0, 10);
    },
  });
  vm.runInContext(stripTypeScriptTypes(src.slice(start, end)), scope);
  return scope.assertOriginalBookingOnlineEditable;
}

for (const [file, end] of [
  ['supabase/functions/booking-api/index.ts', 'async function bookingServiceTypes('],
  ['supabase/functions/booking-group-api/index.ts', 'async function memberBootstrap('],
]) {
  test('AC-004: server '+file+' rejects original appointment when cutoff elapsed and does not require a new booking date', () => {
    const check = loadGuard(file, end);
    assert.throws(() => check(original, settings), { status:409, code:'BOOKING_ONSITE_EDIT_REQUIRED', message: '請到店處理修改。' });
  });
  test('AC-002: server '+file+' permits a still-future appointment within advance window', () => {
    const check = loadGuard(file, end);
    assert.doesNotThrow(() => check({ ...original, booking_date:'2026-11-26', start_at:future },settings));
    assert.doesNotThrow(() => check(original, { ...settings, min_advance_days:0 }));
  });
  test('AC-004: server '+file+' blocks exact start-time boundary and pending cancellation', () => {
    const check = loadGuard(file, end);
    assert.throws(() => check({ ...original, start_at:nowText }, { ...settings,min_advance_days:0 }),{ code:'BOOKING_ONSITE_EDIT_REQUIRED' });
    assert.throws(() => check({ ...original, status:'completed' },settings),{ code:'BOOKING_NOT_EDITABLE' });
    assert.throws(() => check({ ...original, cancellation_requested_at:nowText },settings),{ code:'BOOKING_NOT_EDITABLE' });
  });
}
