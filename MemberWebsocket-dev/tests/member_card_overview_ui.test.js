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

test('member overview shows one member code, copy action, and tier progress', () => {
  assert.match(html, /class="member-overview"/);
  assert.match(html, /<dl class="pass-member-code">/);
  assert.equal((html.match(/id="memberCode"/g) || []).length, 1);
  assert.equal((html.match(/id="copyMemberCodeButton"/g) || []).length, 1);
  assert.match(html, /<span id="memberCode">—<\/span><button id="copyMemberCodeButton"/);
  assert.match(html, /id="memberPassActions"/);
  assert.match(html, /id="membershipProgress"/);
});

test('quick actions are grouped inside the card without losing their handlers', () => {
  assert.match(growth, /getElementById\('memberPassActions'\) \|\| pass/);
  assert.match(growth, /actions\.append\(trigger\)/);
  assert.match(growth, /actions\.prepend\(identityQr\)/);
  assert.match(friends, /el\('memberPassActions'\) \|\| pass/);
  assert.match(friends, /actions\.insertBefore\(trigger, el\('openMemberReferral'\) \|\| null\)/);
  assert.match(html, /<p class="pass-actions-heading">快捷操作<\/p>/);
  assert.match(growth, /QRDisplayDialog\?\.show/);
});

test('scoped style retains tier background, mobile layout, accessible focus and motion', () => {
  assert.match(html, /member-card-refresh\.css\?v=member-overview-20261010-2/);
  assert.match(styles, /var\(--pass-background\)/);
  assert.match(styles, /data-membership-tier-style/);
  assert.match(styles, /@media \(max-width: 420px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1\.45fr\)/);
  assert.match(styles, /#showMemberIdentityQr \{ grid-column: 1 \/ -1; \}/);
  assert.match(styles, /min-height: 46px/);
  assert.doesNotMatch(html, /style="/);
});