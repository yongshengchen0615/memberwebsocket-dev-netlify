const { test } = require('node:test');
const assert = require('node:assert/strict');
const hours = require('../supabase/functions/_shared/booking-hours.ts');

test('ordinary and overnight windows keep the opening business date', () => {
  assert.deepEqual(hours.workWindow('09:00', '18:00'), { start: 540, end: 1080, overnight: false });
  assert.deepEqual(hours.workWindow('14:00', '02:00'), { start: 840, end: 1560, overnight: true });
  assert.equal(hours.timeOnBusinessDate('2026-09-27', 840), '2026-09-27T14:00:00+08:00');
  assert.equal(hours.timeOnBusinessDate('2026-09-27', 1560), '2026-09-28T02:00:00+08:00');
  assert.equal(hours.clockTime(1470), '00:30');
});

test('after midnight the prior opening date remains the business date until closing', () => {
  assert.equal(hours.currentBusinessDate('2026-10-01', 30, '14:00', '02:00'), '2026-09-30');
  assert.equal(hours.currentBusinessDate('2026-10-01', 120, '14:00', '02:00'), '2026-10-01');
  assert.equal(hours.currentBusinessDate('2026-10-01', 30, '09:00', '18:00'), '2026-10-01');
});

test('midnight, month and year rollover use full dates for conflicts', () => {
  assert.equal(hours.timeOnBusinessDate('2026-09-30', 1470), '2026-10-01T00:30:00+08:00');
  assert.equal(hours.timeOnBusinessDate('2026-12-31', 1470), '2027-01-01T00:30:00+08:00');
  const existing = hours.occupiedRange({ start_at: '2026-10-01T00:15:00', end_at: '2026-10-01T01:15:00' });
  const candidate = hours.localRange('2026-09-30', 1470, 30);
  assert.ok(candidate.start < existing.end && candidate.end > existing.start);
  assert.equal(hours.localTimestamp('2026-10-01 00:30:00'), '2026-10-01T00:30:00+08:00');
});

test('zero length and malformed times are rejected', () => {
  assert.throws(() => hours.workWindow('14:00', '14:00'), /INVALID_WORK_HOURS/);
  assert.throws(() => hours.workWindow('24:00', '02:00'), /INVALID_WORK_HOURS/);
  assert.throws(() => hours.workWindow('14:60', '02:00'), /INVALID_WORK_HOURS/);
});
