const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'supabase/functions/booking-admin-operations/index.ts'),
  'utf8',
);

test('booking admin failures expose a safe correlation id', () => {
  assert.match(source, /const requestId = createRequestId\(\)/);
  assert.match(source, /requestId,/);
  assert.match(source, /return errorResponse\(origin, apiError, requestId\)/);
});

test('only server failures emit structured redacted logs', () => {
  const reporter = source.slice(
    source.indexOf('function reportServerError'),
    source.indexOf('function errorResponse'),
  );
  assert.match(reporter, /if \(apiError\.status < 500\) return/);
  assert.match(reporter, /console\.error\(JSON\.stringify\(\{/);
  for (const field of ['event', 'request_id', 'action', 'status', 'code']) {
    assert.match(reporter, new RegExp('\\b' + field + ':'));
  }
  assert.doesNotMatch(reporter, /message|details|body|token|identity|lineUserId/i);
});
