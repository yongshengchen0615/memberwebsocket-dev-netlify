const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const file = require('node:path').join(__dirname, '../admin/calendar-navigation.js');
const navigation = fs.existsSync(file) ? require(file) : {};

test('AC-001: month strip crosses the year without skipping or duplicating a month', () => {
  assert.equal(typeof navigation.monthSequence, 'function', 'Calendar navigation model is available');
  assert.deepEqual(navigation.monthSequence('2026-11-01'), [
    '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01',
    '2027-02-01', '2027-03-01', '2027-04-01', '2027-05-01', '2027-06-01',
    '2027-07-01', '2027-08-01', '2027-09-01'
  ]);
});

test('AC-001/002: navigation uses calendar arithmetic and rejects impossible input', () => {
  assert.equal(typeof navigation.shiftDate, 'function');
  for (const [date, offset, expected] of [
    ['2026-12-31', 1, '2027-01-01'], ['2027-01-01', -1, '2026-12-31'],
    ['2028-02-28', 1, '2028-02-29'], ['2026-02-28', 1, '2026-03-01'],
    ['2026-02-29', 1, ''], ['2026-13-01', 1, ''], ['', 1, ''],
    ['2026-11-26', NaN, ''], ['2026-11-26', 1.5, '']
  ]) assert.equal(navigation.shiftDate(date, offset), expected);
  assert.deepEqual(navigation.monthSequence('2026-02-29'), []);
});

test('AC-002: overnight bookings appear on both days with exact visible segments', () => {
  assert.equal(typeof navigation.bookingSegment, 'function');
  const booking = { bookingDate: '2026-12-31', startTime: '23:30', endTime: '01:10' };
  assert.deepEqual(navigation.bookingSegment(booking, '2026-12-31'), { start:1410, end:1440, fromPreviousDay:false, continues:true });
  assert.deepEqual(navigation.bookingSegment(booking, '2027-01-01'), { start:0, end:70, fromPreviousDay:true, continues:false });
  assert.equal(navigation.bookingSegment(booking, '2027-01-02'), null);
  assert.deepEqual(navigation.bookingSegment({ ...booking, startTime:'09:10:00', endTime:'10:20:00' }, '2026-12-31'), { start:550, end:620, fromPreviousDay:false, continues:false });
  for (const invalid of ['25:00', '09:99', 'bad', '']) assert.equal(navigation.bookingSegment({ ...booking, startTime:invalid }, '2026-12-31'), null);
  assert.equal(navigation.bookingSegment({ ...booking, startTime:'09:00', endTime:'09:00' }, '2026-12-31'), null);
});
