const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..');
const receiptSource = readFileSync(join(root, 'booking/booking-receipt.js'), 'utf8');
const accessibleSource = readFileSync(join(root, 'booking/booking-accessible.js'), 'utf8');
const pageSource = readFileSync(join(root, 'booking/index.html'), 'utf8');

function snapshotHelpers(sender) {
  const window = { BookingSystem: { sendMemberChatMessage: sender }, addEventListener() {} };
  const document = { addEventListener() {} };
  const code = receiptSource.replace(
    '  async function submitReceipt() {',
    '  window.__snapshotChatTest = { snapshotConfirmationChatText, sendSnapshotConfirmationChatMessage };\n  async function submitReceipt() {',
  );
  assert.notEqual(code, receiptSource, 'snapshot helper injection anchor must exist');
  vm.runInNewContext(code, { window, document, console });
  return { helpers: window.__snapshotChatTest, window };
}

test('successful snapshot confirmation sends member-authored LINE text without sensitive data', async () => {
  const sent = [];
  const { helpers } = snapshotHelpers(async text => {
    sent.push(text);
    return { sent: true, reason: '' };
  });
  const result = await helpers.sendSnapshotConfirmationChatMessage('RCP-123', 2);
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^【快照確認】/);
  assert.match(sent[0], /等待管理員審核/);
  assert.match(sent[0], /快照編號：RCP-123/);
  assert.match(sent[0], /登記票券：2 張（待審核，尚未核銷）/);
  assert.doesNotMatch(sent[0], /latitude|longitude|GPS|收據圖片/);
});

test('LINE failure or missing LIFF send hook does not throw or re-finalize the snapshot', async () => {
  const { helpers, window } = snapshotHelpers(async () => { throw new Error('LINE unavailable'); });
  const failed = await helpers.sendSnapshotConfirmationChatMessage('RCP-123', 0);
  assert.equal(failed.sent, false);
  assert.equal(failed.reason, 'send_failed');
  delete window.BookingSystem.sendMemberChatMessage;
  const missing = await helpers.sendSnapshotConfirmationChatMessage('RCP-123', 0);
  assert.equal(missing.sent, false);
  assert.equal(missing.reason, 'send_messages_unavailable');
});

test('chat send occurs only after finalized receipt and skips idempotent replays', () => {
  assert.match(receiptSource, /const finalized = await window\.BookingSystem\.request\([\s\S]*?'user\.booking\.receipt\.finalize'/);
  assert.match(receiptSource, /submitted = true;\s*let chatResult = null;\s*if \(state\.accessible && finalized\.alreadyApplied !== true\)/);
  assert.match(receiptSource, /chatResult = await sendSnapshotConfirmationChatMessage\(\s*String\(finalized\.receiptId \|\| prepared\.receiptId \|\| ''\), selectedBenefits\.length/);
  assert.match(receiptSource, /booking:accessible-receipt-submitted[\s\S]*?chatResult/);
  assert.match(accessibleSource, /chatResult\?\.sent === true/);
  assert.match(accessibleSource, /chatResult\?\.reason === 'not_in_line_chat'/);
  assert.match(accessibleSource, /lastChatFeedback\?\.receiptId === String\(latest\.receiptId \|\| ''\)/);
  assert.match(pageSource, /booking-receipt\.js\?v=[^" ]*snapshot-line-chat-20261012-1/);
  assert.match(pageSource, /booking-accessible\.js\?v=[^" ]*snapshot-line-chat-20261012-1/);
});
