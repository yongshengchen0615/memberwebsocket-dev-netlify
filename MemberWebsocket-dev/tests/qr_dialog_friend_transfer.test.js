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

test('friend and reward QR dialogs keep referral and friend workflows separate', () => {
  const friends = read('friends.js');
  const referral = read('member/member-growth.js');
  const html = read('member/index.html');
  assert.match(friends, /QRScanDialog\?\.open\(camera/);
  assert.match(friends, /onResult: code =>/);
  assert.match(friends, /void lookup\(\)/);
  assert.match(referral, /QRScanDialog\?\.open\(camera/);
  assert.match(referral, /member\.referral\.bind/);
  assert.match(referral, /stopReferralScan\(\)/);
  assert.match(html, /qr-scan-dialog\.js/);
});

test('point transfer only selects and verifies QR or accepted friends before original idempotent server write', () => {
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
  assert.match(ui, /parseTransferQR/);
  assert.match(ui, /url\.origin !== base\.origin/);
  assert.match(ui, /hash\.get\('friend'\) \|\| hash\.get\('reward'\)/);
  assert.match(ui, /stopTransferScanner\(\)/);
  assert.match(html, /friend-qr-decoder\.js/);
  assert.match(html, /qr-scan-dialog\.js/);
  assert.match(api, /points: new Set\(\["points\.transfer\.options","points\.transfer\.receiver","points\.transfer\.create","member\.friend\.list"\]\)/);
  assert.match(api, /await consumeRateLimit\(supabase, identity, write\)/);
  assert.match(api, /await requireMember\(supabase, identity\)/);
  assert.match(api, /supabase\.rpc\("member_friend_action",\{p_actor:identity\.lineUserId/);
});
