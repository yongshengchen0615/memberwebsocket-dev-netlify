'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const memberGrowthSource = fs.readFileSync(path.join(__dirname, '../member/member-growth.js'), 'utf8');

function createJoinFixture({ config = {}, pageTitle = '會員卡｜Lumen Club', inClient = true, contextType = 'utou' } = {}) {
  const events = new Map();
  const formEvents = new Map();
  const sent = [];
  const form = { dataset: {}, addEventListener: (name, cb) => formEvents.set(name, cb) };
  const document = {
    title: pageTitle,
    hidden: false,
    getElementById: (id) => id === 'profileForm' ? form : null,
    addEventListener() {},
  };
  const window = {
    addEventListener: (name, cb) => events.set(name, cb),
    MemberSystem: { getSession: (surface) => surface === 'member' ? { config } : null },
    liff: {
      isInClient: () => inClient,
      getContext: () => ({ type: contextType }),
      sendMessages: async (messages) => { sent.push(messages); },
    },
  };
  vm.runInNewContext(memberGrowthSource, { window, document, console, URL, URLSearchParams, navigator: {}, location: {} }, { filename: 'member-growth.js' });
  events.get('DOMContentLoaded')();
  return {
    sent,
    submit: () => formEvents.get('submit')(),
    complete: () => events.get('member-profile-ready')({ detail: { profile: { lineUserId: 'U-TEST' } } }),
  };
}

test('AC-001 uses the configured webpage heading without the removed suffix', () => {
  const fixture = createJoinFixture({ config: { pageTitle: '星河生活館', brandName: '舊商家名稱' } });
  fixture.submit();
  fixture.complete();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.sent)), [[{ type: 'text', text: '我已完成 星河生活館 會員註冊' }]]);
});

test('AC-002 uses the current business heading in a tenant session', () => {
  const fixture = createJoinFixture({ config: { brandName: '海風養護' } });
  fixture.submit();
  fixture.complete();
  assert.equal(fixture.sent[0][0].text, '我已完成 海風養護 會員註冊');
});

test('AC-003 falls back to the member page title with its section prefix removed', () => {
  const fixture = createJoinFixture({ pageTitle: '會員卡｜晨光會員中心' });
  fixture.submit();
  fixture.complete();
  assert.equal(fixture.sent[0][0].text, '我已完成 晨光會員中心 會員註冊');
});

test('AC-004 sends only once after a real join submission', () => {
  const fixture = createJoinFixture({ config: { brandName: '商家 A' } });
  fixture.complete();
  assert.equal(fixture.sent.length, 0);
  fixture.submit();
  fixture.complete();
  fixture.complete();
  assert.equal(fixture.sent.length, 1);
});

test('AC-005 does not send outside a one-to-one LINE in-app conversation', () => {
  for (const options of [{ inClient: false }, { contextType: 'group' }]) {
    const fixture = createJoinFixture(options);
    fixture.submit();
    fixture.complete();
    assert.equal(fixture.sent.length, 0);
  }
});
