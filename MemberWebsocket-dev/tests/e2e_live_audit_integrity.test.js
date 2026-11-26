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

test('points transfer QA enforces direct member-number copy and no QR transaction shortcut', () => {
  const runner=read('user-test-control.js');
  const transfer=read('points/point-transfer.js');
  const html=read('points/index.html');
  assert.match(html, /<div class="active-card-actions">[\s\S]*id="pointTransferCopyOwnCode"/);
  assert.match(transfer, /copyButton\.addEventListener\('click'/);
  assert.match(transfer, /'points\.transfer\.receiver'/);
  assert.match(transfer, /'points\.transfer\.create'/);
  assert.doesNotMatch(transfer, /pointTransferShowOwnQr|pointTransferScanQr/);
  assert.match(runner, /ownCodeCopyControl: Boolean\(ownCopy\)/);
  assert.match(runner, /qrControlRemoved: qrRemoved/);
  assert.match(runner, /actual\.ownCodeCopyControl && actual\.qrControlRemoved/);
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
