const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = file => readFileSync(join(root, file), 'utf8');

test('full server QA runs never pass when any case was skipped or omitted', () => {
  const admin = read('supabase/functions/test-control-api/index.ts');
  const user = read('supabase/functions/user-test-api/index.ts');
  assert.match(admin, /counters\.total > 0 && counters\.passed === counters\.total && counters\.failed === 0 && counters\.skipped === 0/);
  assert.match(user, /cases\.length > 0 && passedCount === cases\.length && failedCount === 0 && skippedCount === 0/);
  assert.doesNotMatch(admin, /const finalStatus = counters\.failed === 0 \? "passed"/);
  assert.doesNotMatch(user, /const finalStatus = failedCount > 0 \? "failed" : "passed"/);
});

test('points transfer QA asserts current own-QR UI, not deleted copy button', () => {
  const testRunner = read('user-test-control.js');
  const transfer = read('points/point-transfer.js');
  assert.match(transfer, /id="pointTransferShowOwnQr"/);
  assert.doesNotMatch(transfer, /id="pointTransferCopyOwnCode"/);
  assert.match(testRunner, /ownQrControl: Boolean\(ownQr\)/);
  assert.match(testRunner, /deprecatedCopyRemoved: !removedCopy/);
  assert.match(testRunner, /actual\.ownQrControl && actual\.deprecatedCopyRemoved/);
});

test('GPS retry controls are registered in E2E discovery and wired to real refresh actions', () => {
  const runner = read('user-test-control.js');
  const points = read('points/pointcard-ticket-overview.js');
  const event = read('event/app.js');
  assert.match(runner, /ticket-batch-\(cancel\|confirm\)\|ticket-live-location-confirm/);
  assert.match(runner, /event-history-button\|ticketModalLocationButton/);
  assert.match(points, /className = 'ticket-live-location-confirm'/);
  assert.match(points, /addEventListener\('click', \(\) => \{ void refreshLiveLocation\(\); \}\)/);
  assert.match(event, /els\.ticketModalLocationButton\.addEventListener\('click', \(\) => \{ void refreshLiveLocation\(\); \}\)/);
});
