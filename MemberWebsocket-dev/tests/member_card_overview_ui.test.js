const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('member/index.html');
const styles = read('member/member-card-refresh.css');
const growth = read('member/member-growth.js');
const friends = read('friends.js');

test('member overview retains progress and direct member number copy without QR UI', () => {
  assert.match(html, /class="member-overview"/);
  assert.match(html, /id="memberPass"/);
  assert.doesNotMatch(html, /pass-member-code|id="memberCode"|id="copyMemberCodeButton"/);
  assert.match(html, /id="memberPassActions"/);
  assert.match(html, /id="membershipProgress"/);
  assert.match(growth, /copy\.textContent = '複製會員編號'/);
  assert.match(growth, /navigator\.clipboard\.writeText\(code\)/);
  assert.doesNotMatch(growth, /QRDisplayDialog\?\.show/);
});

test('quick actions are grouped inside the card without losing their handlers', () => {
  assert.match(growth, /getElementById\('memberPassActions'\) \|\| pass/);
  assert.match(growth, /actions\.append\(trigger\)/);
  assert.match(growth, /actions\.prepend\(copy\)/);
  assert.match(friends, /el\('memberPassActions'\) \|\| pass/);
  assert.match(friends, /actions\.insertBefore\(trigger, el\('openMemberReferral'\) \|\| null\)/);
  assert.match(html, /<p class="pass-actions-heading">快捷操作<\/p>/);
  assert.match(growth, /copy\.addEventListener\('click'/);
});

test('scoped style retains tier background, mobile layout, accessible focus and motion', () => {
  assert.match(html, /member-card-refresh\.css\?v=member-overview-20261117-1/);
  assert.match(styles, /var\(--pass-background\)/);
  assert.match(styles, /data-membership-tier-style/);
  assert.match(styles, /@media \(max-width: 420px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1\.45fr\)/);
  assert.match(styles, /#copyMemberIdentityCode \{ grid-column: 1 \/ -1; \}/);
  assert.match(styles, /min-height: 46px/);
  assert.doesNotMatch(html, /style="/);
});