const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('QR dialog is reusable, modal, stops camera, and rejects stale camera callbacks through existing scanner', () => {
  const dialog = read('qr-scan-dialog.js');
  const scanner = read('friend-qr-scanner.js');
  assert.doesNotThrow(() => new Function(dialog));
  assert.match(dialog, /aria-modal/);
  assert.match(dialog, /aria-label/);
  assert.match(dialog, /current\.stop\?\.\(\)/);
  assert.match(dialog, /current\.panel\.hidden = true/);
  assert.match(dialog, /current\.parent\.insertBefore/);
  assert.match(dialog, /stopImmediatePropagation/);
  assert.match(dialog, /visibilitychange/);
  assert.match(dialog, /pagehide/);
  assert.match(scanner, /generation\+\+/);
  assert.match(scanner, /getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
});

test('invitation and friend operations require member numbers without any QR scanner', () => {
  const friends = read('friends.js');
  const referral = read('member/member-growth.js');
  const html = read('member/index.html');
  assert.match(friends, /parseMemberCode/);
  assert.match(friends, /'member'[,\s\S]*?'member\.friend\.'/);
  assert.match(referral, /member\.referral\.bind/);
  assert.match(referral, /memberCode: candidate/);
  assert.match(referral, /copyMemberIdentityCode/);
  for (const module of [friends, referral]) {
    assert.doesNotMatch(module, /scanFriendQr|scanMemberReferralQr|friendQrFile|memberReferralQrFile/);
  }
  assert.doesNotMatch(html, /friend-qr-scanner\.js|friend-qrcode\.js|friend-qr-decoder\.js/);
});

test('point transfer confirms typed member code and retains transactional idempotency', () => {
  const ui = read('points/point-transfer.js');
  const html = read('points/index.html');
  const api = read('supabase/functions/member-growth-api/index.ts');
  assert.doesNotThrow(() => new Function(ui));
  assert.match(ui, /friend\.status === 'accepted'/);
  assert.match(ui, /'member\.friend\.list'/);
  assert.match(ui, /'points\.transfer\.receiver'/);
  assert.match(ui, /'points\.transfer\.create'/);
  assert.match(ui, /state\.fingerprint !== fingerprint/);
  assert.match(ui, /requestId: state\.requestId/);
  assert.doesNotMatch(ui, /parseTransferQR|pointTransferScanQr|pointTransferQrPanel/);
  assert.match(html, /pointTransferCopyOwnCode/);
  assert.doesNotMatch(html, /friend-qr-scanner\.js|friend-qr-decoder\.js/);
  assert.match(api, /points: new Set\(\["points\.transfer\.options","points\.transfer\.receiver","points\.transfer\.create","member\.friend\.list"\]\)/);
  assert.match(api, /await consumeRateLimit\(supabase, identity, write\)/);
  assert.match(api, /await requireMember\(supabase, identity\)/);
});
