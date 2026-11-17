const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const html = read('member', 'index.html');
const app = read('member', 'app.js');
const growth = read('member', 'member-growth.js');
const qrDialog = read('qr-scan-dialog.js');

test('member card no longer renders the separate member identifier or copy button', () => {
  assert.doesNotMatch(html, /pass-member-code|id="memberCode"|id="copyMemberCodeButton"/);
  assert.doesNotMatch(app, /copyMemberCodeButton|els\.memberCode\b|copyMemberCode\(|currentMemberCode\(|memberCodeCopyResetTimer/);
});
test('member QR button still opens the shared dialog using the profile identifier', () => {
  assert.match(growth, /identityQr\.textContent = '顯示會員 QR Code'/);
  assert.match(growth, /QRDisplayDialog\?\.show\(\{memberCode: state\.profile\?\.memberCode, opener: identityQr\}\)/);
  assert.match(growth, /identityButton\.disabled = !code/);
});
test('QR dialog preserves the identifier, copy action and success feedback', () => {
  assert.match(qrDialog, /show\(\{ title = '會員 QR Code', memberCode, value = memberCode/);
  assert.match(qrDialog, /copy\.textContent = '複製會員編號'/);
  assert.match(qrDialog, /navigator\.clipboard\.writeText\(code\)/);
  assert.match(qrDialog, /會員編號已複製/);
});

test('membership page loads the refreshed shared QR dialog after copy feedback race fix', () => {
  assert.match(html, /qr-scan-dialog\\.js\\?v=qr-dialog-20261008-1-receipt-camera-20261008-1-ongoing-20261010-1-copy-feedback-20261117-1/);
});
