'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const memberRoot = path.join(__dirname, '..', 'member');
const html = fs.readFileSync(path.join(memberRoot, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(memberRoot, 'member-card-refresh.css'), 'utf8');

test('AC-001: member profile has no exploration feature navigation', () => {
  assert.doesNotMatch(html, /<nav\b[^>]*\bid=["']memberFeatureLinks["']/i);
  assert.doesNotMatch(html, /探索會員功能|會員功能入口|member-feature-links/);
});

test('AC-002: the member profile and its edit dialogs remain available', () => {
  for (const id of ['memberPhone', 'editPhoneButton', 'memberBirthday', 'editBirthdayButton', 'memberHonorificName', 'honorificEditModal']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  for (const route of ['points', 'event', 'calendar', 'booking']) {
    assert.ok(fs.existsSync(path.join(memberRoot, '..', route, 'index.html')), route + ' route must still exist');
  }
});

test('AC-003: the retired navigation has no orphaned responsive CSS rules', () => {
  assert.doesNotMatch(css, /\.member-feature-links\b/);
});
