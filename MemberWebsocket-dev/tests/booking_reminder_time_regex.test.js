const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const files = [
  ['booking/app.js', 'reminderTime'],
  ['supabase/functions/booking-api/index.ts', 'time'],
  ['supabase/functions/booking-group-api/index.ts', 'time'],
  ['supabase/functions/booking-contact-api/index.ts', 'reminderTime'],
];

function validator(file, variable) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const line = source.split('\n').find(text => text.includes('.test(' + variable + ')')
    && text.includes('^([01]'));
  assert.ok(line, file + ': time validation must exist');
  const literal = line.match(/(\/\^[^/]*\$\/)\.test\(/)?.[1];
  assert.ok(literal, file + ': extract real regular expression');
  return vm.runInNewContext(literal);
}

for (const [file, variable] of files) {
  test('AC-015: ' + file + ' accepts actual HH:MM input and rejects malformed times', () => {
    const pattern = validator(file, variable);
    for (const time of ['00:00', '09:05', '12:30', '18:00', '19:30', '23:59']) {
      assert.equal(pattern.test(time), true, file + ': must accept ' + time);
    }
    for (const time of ['24:00', '9:05', '18:60', '19:30:00', 'hello', '', '00:0']) {
      assert.equal(pattern.test(time), false, file + ': must reject ' + time);
    }
  });
}

test('AC-016: member booking accepts YYYY-MM-DD slot dates before checking prior-day cutoff', () => {
  const source = fs.readFileSync(path.join(root, 'booking/app.js'), 'utf8');
  const line = source.split('\n').find(text => text.includes('.test(actualStartDate)'));
  assert.ok(line);
  const literal = line.match(/(\/\^[^/]*\$\/)\.test\(/)?.[1];
  assert.ok(literal, 'extract date regular expression');
  const pattern = vm.runInNewContext(literal);
  assert.equal(pattern.test('2026-11-02'), true, 'normal booking date accepted');
  assert.equal(pattern.test('2026-10-31'), true, 'normal booking date accepted');
  assert.equal(pattern.test('2026/11/02'), false, 'invalid date separator rejected');
  assert.equal(pattern.test('2026-11-2'), false, 'non-padded date rejected');
});

test('AC-017: booking page pins the corrected reminder validator so cached broken JS is bypassed', () => {
  const html = fs.readFileSync(path.join(root, 'booking/index.html'), 'utf8');
  const match = html.match(/<script src="\.\/app\.js\?v=([^"]+)" defer><\/script>/);
  assert.ok(match, 'booking page should load versioned member app');
  assert.ok(match[1].endsWith('reminder-time-regex-20261031-2'),
    'booking app must reference the corrected validator version');
});
