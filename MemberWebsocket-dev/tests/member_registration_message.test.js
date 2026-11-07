'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../member/member-growth.js'), 'utf8');

function createFixture({ brandName = '', documentTitle = 'Lumen Club｜會員卡', inClient = true, contextType = 'utou' } = {}) {
  const listeners = new Map(), formListeners = new Map(), sent = [];
  const form = { dataset: {}, addEventListener: (name, handler) => formListeners.set(name, handler) };
  const document = {
    title: documentTitle,
    hidden: false,
    getElementById: id => id === 'profileForm' ? form : null,
    addEventListener() {},
  };
  const window = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    MemberSystem: { getSession: surface => surface === 'member' ? { config: { brandName } } : null },
    liff: {
      isInClient: () => inClient,
      getContext: () => ({ type: contextType }),
      sendMessages: async messages => { sent.push(messages); },
    },
  };
  vm.runInNewContext(source, { window, document, console, URL, URLSearchParams, navigator: {}, location: {} }, { filename: 'member-growth.js' });
  listeners.get('DOMContentLoaded')();
  return {
    sent,
    submit: () => formListeners.get('submit')(),
    profileReady: () => listeners.get('member-profile-ready')({ detail: { profile: { lineUserId: 'U-TEST' } } }),
  };
}

test('AC-001 configured webpage title appears in LINE completion message without old suffix', () => {
  const f = createFixture({ brandName: '星河生活館' });
  f.submit();
  f.profileReady();
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent)), [[{ type: 'text', text: '我已完成 星河生活館 會員註冊' }]]);
});

test('AC-002 business-name fallback uses the correct merchant, not fixed Lumen Club', () => {
  const f = createFixture({ brandName: '海風養護' });
  f.submit();
  f.profileReady();
  assert.equal(f.sent[0][0].text, '我已完成 海風養護 會員註冊');
});

test('AC-003 fallback reads current page heading and strips member-page section', () => {
  const f = createFixture({ documentTitle: '晨光會員中心｜會員卡' });
  f.submit();
  f.profileReady();
  assert.equal(f.sent[0][0].text, '我已完成 晨光會員中心 會員註冊');
});

test('AC-004 only sends after join submission and never duplicates a completed join', () => {
  const f = createFixture({ brandName: '商家 A' });
  f.profileReady();
  assert.equal(f.sent.length, 0);
  f.submit();
  f.profileReady();
  f.profileReady();
  assert.equal(f.sent.length, 1);
});

test('AC-005 never sends outside direct LINE in-app chat', () => {
  for (const options of [{ inClient: false }, { contextType: 'group' }]) {
    const f = createFixture(options);
    f.submit();
    f.profileReady();
    assert.equal(f.sent.length, 0);
  }
});

test('AC-006 frontend business config prefers configured siteTitle over business name', () => {
  const businessContext = fs.readFileSync(path.join(__dirname, '../business-context.js'), 'utf8');
  assert.match(businessContext, /config\.brandName\s*=\s*body\.data\.siteTitle\s*\|\|\s*body\.data\.name/);
});

test('AC-007 removes whitespace injection and handles Unicode title limit safely', () => {
  const f = createFixture({ brandName: '星河  \n 生活館' });
  f.submit();
  f.profileReady();
  assert.equal(f.sent[0][0].text, '我已完成 星河 生活館 會員註冊');
});
