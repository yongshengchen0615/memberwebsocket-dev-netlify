const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('AC-001: referral reward starts from member-number input without camera or QR actions', () => {
  const ui = read('member/member-growth.js');
  assert.match(ui, /memberReferralInviteCode/);
  assert.match(ui, /member\.referral\.bind/);
  assert.match(ui, /memberCode: candidate/);
  for (const id of ['scanMemberReferralQr', 'uploadMemberReferralQr', 'memberReferralQrFile', 'memberReferralQrScanner']) {
    assert.doesNotMatch(ui, new RegExp(id));
  }
  assert.match(ui, /請輸入對方的會員編號/);
});

test('AC-002: gifting validates member number and keeps exact-once server transfer', () => {
  const ui = read('points/point-transfer.js');
  const html = read('points/index.html');
  assert.match(ui, /pointTransferMemberCode/);
  assert.match(ui, /'points\.transfer\.receiver'/);
  assert.match(ui, /'points\.transfer\.create'/);
  assert.match(ui, /requestId: state\.requestId/);
  assert.match(ui, /!\/\^\[A-Z0-9_-\]\{4,40\}\$\//);
  assert.match(ui, /memberCode === state\.memberCode\.toUpperCase\(\)/);
  for (const id of ['pointTransferScanQr', 'pointTransferQrFile', 'pointTransferQrVideo', 'parseTransferQR']) {
    assert.doesNotMatch(ui, new RegExp(id));
  }
  assert.doesNotMatch(html, /friend-qr-decoder\.js|friend-qrcode\.js|friend-qr-scanner\.js/);
});

test('AC-003: member and point card show copyable member number instead of QR display', () => {
  const member = read('member/member-growth.js');
  const points = read('points/point-transfer.js');
  const memberHtml = read('member/index.html');
  const pointsHtml = read('points/index.html');
  assert.match(member, /copyMemberIdentityCode/);
  assert.match(pointsHtml, /pointTransferCopyOwnCode/);
  assert.match(points, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(member, /showMemberIdentityQr/);
  assert.doesNotMatch(pointsHtml, /pointTransferShowOwnQr/);
  assert.doesNotMatch(memberHtml, /friend-qr-decoder\.js|friend-qrcode\.js|friend-qr-scanner\.js/);
});

test('AC-004: friend lookup also uses manual member number, never a QR camera', () => {
  const ui = read('friends.js');
  assert.match(ui, /friendLookupCode/);
  assert.match(ui, /member\.friend\./);
  for (const id of ['scanFriendQr', 'friendQrFile', 'friendQrScanner', 'uploadFriendQr']) {
    assert.doesNotMatch(ui, new RegExp(id));
  }
});

test('AC-005: code binding is primary, new-member link remains secondary', () => {
  const invites = read('member/member-invitations.js');
  assert.match(invites, /memberInvitationPanel/);
  assert.match(invites, /會員編號/);
  assert.doesNotMatch(invites, /legacyMemberReferral/);
  assert.match(invites, /newMemberInvitationLinks/);
  assert.match(invites, /LINE 邀請尚未入會的好友/);
});

test('AC-006: revoked sessions must disable copy and prevent a new point gift', () => {
  const points = read('points/point-transfer.js');
  assert.match(points, /window\.addEventListener\('member:access-ended'/);
  assert.match(points, /copyButton\.disabled = !state\.memberCode \|\| !session\(\)/);
  assert.match(points, /if \(!session\(\)\)/);
});
