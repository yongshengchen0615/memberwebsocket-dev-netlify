'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('AC-001: booking manages friends within an in-page dialog without leaving the booking draft', () => {
  const js = read('friends.js');
  assert.ok(!js.includes('href="../member/#friends"'), 'no member card redirect');
  assert.ok(js.includes('id="openBookingFriends"'));
  assert.ok(js.includes("bookingFriendsModal.classList.remove('hidden')"));
  assert.ok(js.includes("bookingFriendsModal.classList.add('hidden')"));
  assert.ok(js.includes('aria-haspopup="dialog"'));
});

test('AC-002: modal renders real friend list and retains server-authorized actions', () => {
  const js = read('friends.js');
  assert.ok(js.includes('id="friendList"'));
  assert.ok(js.includes('id="friendListStatus"'));
  assert.ok(js.includes('renderFriendList(result)'));
  assert.ok(js.includes('await request(operation, friend.memberCode)'));
  assert.ok(js.includes('if (current !== generation) return;'));
  assert.ok(js.includes("el('friendBookingRecipient')"));
  assert.ok(js.includes('lockedRecipient'));
});

test('AC-003: booking friend dialog closes by button, backdrop and Escape', () => {
  const js = read('friends.js');
  assert.ok(js.includes('id="closeBookingFriends"'));
  assert.ok(js.includes("bookingFriendsModal.addEventListener('click'"));
  assert.ok(js.includes("event.key === 'Escape'"));
  assert.ok(js.includes('trigger.focus()'));
});

test('AC-004: manage button is visually distinct, touch accessible and cache-busted', () => {
  const css = read('friends.css');
  assert.ok(css.includes('.booking-recipient-actions .booking-manage-friends'));
  assert.ok(css.includes('min-height:44px'));
  assert.ok(css.includes('.booking-friends-modal'));
  assert.ok(read('booking/index.html').includes('friends.js?v=booking-manage-friends-20261101-1'));
});
