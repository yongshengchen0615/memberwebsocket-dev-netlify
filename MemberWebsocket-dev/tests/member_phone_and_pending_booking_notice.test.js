const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./helpers/edge-test-fs.cjs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('member join and edit phone fields share country-code E.164 composition', () => {
  const html = read('member/index.html');
  const app = read('member/app.js');
  const profile = read('member/profile-extension.js');
  const helper = read('member/member-phone.js');

  assert.match(html, /id="profileCountryCode"/);
  assert.match(html, /id="phoneEditCountryCode"/);
  assert.match(html, /value="\+886">台灣 \+886/);
  assert.match(app, /MemberPhone\?\.compose\(els\.profileCountryCode\.value, els\.profilePhone\.value\)/);
  assert.match(profile, /MemberPhone\?\.compose\(valueOf\('phoneEditCountryCode'\), valueOf\('phoneEditInput'\)\)/);

  const sandbox = { window: {} };
  vm.runInNewContext(helper, sandbox);
  const phone = sandbox.window.MemberPhone;
  assert.equal(phone.compose('+886', '0912-345-678'), '+886912345678');
  assert.equal(phone.compose('+81', '090-1234-5678'), '+819012345678');
  assert.equal(phone.compose('+1', '415-555-2671'), '+14155552671');
  assert.equal(phone.compose('+886', '09AB-345'), '');
  assert.equal(phone.compose('+886', '111111111'), '');
  assert.equal(phone.compose('+886', '011111111'), '');
  assert.equal(phone.isValidPhone('+886912345678'), true);
  assert.equal(phone.isValidPhone('+886111111111'), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(phone.split('+886912345678'))),
    { countryCode: '+886', localNumber: '0912345678' },
  );
});

test('server rejects implausible phones and booking creation never sends client-originated LINE chat', () => {
  const api = read('supabase/functions/member-profile-api/index.ts');
  const bookingCommon = read('booking/common.js');
  const bookingApp = read('booking/app.js');

  assert.match(api, /function isValidPhone/);
  assert.match(api, /value\.startsWith\("\+886"\)/);
  assert.match(api, /if \(hasPhone && !isValidPhone\(phone\)\)/);
  assert.match(bookingCommon, /async function sendMemberChatMessage\(message\)/);
  assert.doesNotMatch(bookingApp, /sendBookingMemberChatMessage|bookingMemberChatText/);
  assert.match(bookingApp, /預約已送出，整段服務時間已保留，等待管理端確認。/);
});

test('snapshot receipt retains the shared LINE sender without re-enabling member booking self-send', async () => {
  const common = read('booking/common.js');
  const receipt = read('booking/booking-receipt.js');
  const sent = [];
  const sandbox = { window: {
    liff: { isInClient: () => true, sendMessages: async (messages) => { sent.push(messages); } },
  }, document: {}, console };
  vm.runInNewContext(common, sandbox, { filename: 'booking/common.js' });
  assert.equal(typeof sandbox.window.BookingSystem.sendMemberChatMessage, 'function');
  const result = await sandbox.window.BookingSystem.sendMemberChatMessage('快照已送出');
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].text, '快照已送出');
  assert.match(receipt, /const sender = window\.BookingSystem\?\.sendMemberChatMessage/);
  assert.doesNotMatch(read('booking/app.js'), /sendBookingMemberChatMessage|bookingMemberChatText/);

  sandbox.window.liff.isInClient = () => false;
  const browserResult = await sandbox.window.BookingSystem.sendMemberChatMessage('快照已送出');
  assert.equal(browserResult.sent, false);
  assert.equal(browserResult.reason, 'not_in_line_chat');
  assert.equal(sent.length, 1);
});
