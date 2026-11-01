'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
test('AC-001: booking manages friends within an in-page dialog without leaving the booking draft', () => {
  const js = read('friends.js');
  assert.doesNotMatch(js, /href="../member\/#friends"[^>]*>管理好友/);
  assert.match(js, /id="openBookingFriends"/);
  assert.match(js, /bookingFriendsModal\.classList\.remove\('hidden'\)/);
  assert.match(js, /bookingFriendsModal\.classList\.add\('hidden'\)/);
  assert.match(js, /aria-haspopup="dialog"/);
});
test('AC-002: booking modal provides real friend list and retains server-authorized actions', () => {
  const js = read('friends.js');
  assert.match(js, /id="friendList"/);
  assert.match(js, /id="friendListStatus"/);
  assert.match(js, /renderFriendList\(result\)/);
  assert.match(js, /await request\(operation, friend\.memberCode\)/);
  assert.match(js, /if \(current !== generation\) return;/);
  assert.match(js, /el\('friendBookingRecipient'\)/);
  assert.match(js, /lockedRecipient/);
});
test('AC-003: booking friend dialog is closable and keyboard accessible', () => {
  const js = read('friends.js');
  assert.match(js, /id="closeBookingFriends"/);
  assert.match(js, /bookingFriendsModal\.addEventListener\('click'/);
  assert.match(js, /event\.key === 'Escape'/);
  assert.match(js, /trigger\.focus\(\)/);
});
test('AC-004: manage button is visually distinct and touch accessible', () => {
  const css = read('friends.css');
  assert.match(css, /\.booking-recipient-actions \.booking-manage-friends/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /\.booking-friends-modal/);
  assert.match(read('booking/index.html'), /friends\.js\?v=/);
});
