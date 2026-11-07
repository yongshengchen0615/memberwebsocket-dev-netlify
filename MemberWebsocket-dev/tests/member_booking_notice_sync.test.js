const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const bookingApi = read('supabase/functions/booking-api/index.ts');
const adminApi = read('supabase/functions/booking-admin-api/index.ts');
const memberCommon = read('booking/common.js');
const memberApp = read('booking/app.js');
const memberHtml = read('booking/index.html');

test('AC-001: admin writes booking instructions to the merchant booking settings with length checks', () => {
  assert.match(adminApi, /bookingNotice: String\(row\?\.booking_notice \|\| ""\)/);
  assert.match(adminApi, /p_booking_notice: bookingNotice/);
  assert.match(adminApi, /bookingNotice\.length > 2000/);
});

test('AC-002: authenticated member bootstrap returns its scoped booking notice', () => {
  assert.match(bookingApi, /function settingsClient\(row: any\): Json \{[\s\S]*?bookingNotice: String\(row\?\.booking_notice \?\? ""\)/);
  assert.match(bookingApi, /async function userBootstrap[\s\S]*?bookingSettings\(supabase\)[\s\S]*?settings: \{ \.\.\.settingsClient\(settings\), serviceTypeRewards \}/);
  assert.match(bookingApi, /const supabase = dbClient\(body\)/);
  assert.match(bookingApi, /const member = await requireJoinedMember\(supabase, identity\)/);
});

test('AC-003: member only renders the latest accepted bootstrap; no global tenant-agnostic RPC', () => {
  assert.doesNotMatch(memberCommon, /get_booking_public_notice|publicNoticeClient|syncPublicBookingNotice/);
  assert.match(memberCommon, /function setBookingNotice\(value\)/);
  assert.match(memberCommon, /request, setBookingNotice, memberProfile/);
  assert.match(memberApp, /if \(refreshSequence !== state\.refreshSequence\) return false;[\s\S]*?state\.data = bookingData \|\| state\.data;[\s\S]*?BookingSystem\.setBookingNotice\(state\.data\?\.settings\?\.bookingNotice\)/);
  assert.match(memberHtml, /id="bookingNotice"[^>]*role="note"/);
  assert.match(memberHtml, /common\.js\?v=[^"]*booking-notice-20261107-1/);
  assert.match(memberHtml, /app\.js\?v=[^"]*booking-notice-20261107-1/);
});

test('AC-004: multiline notices are text-only, and clearing instructions hides the notice', () => {
  const begin = memberCommon.indexOf('  function bookingNoticeElement() {');
  const end = memberCommon.indexOf('  // Only the authorized member bootstrap', begin);
  assert.ok(begin >= 0 && end > begin, 'notice rendering implementation must remain available');
  const code = memberCommon.slice(begin, end);
  const notice = {
    children: [],
    hidden: false,
    classList: {
      contains: (name) => name === 'service-info',
      toggle: (name, enabled) => { assert.equal(name, 'hidden'); notice.hidden = enabled; },
    },
    getAttribute: (name) => name === 'role' ? 'note' : null,
    replaceChildren(...children) { this.children = children; },
  };
  const card = { children: [notice] };
  const document = {
    querySelector(selector) {
      assert.equal(selector, '.booking-card[aria-labelledby="bookingTitle"]');
      return card;
    },
    createElement(tagName) { return { tagName, textContent: '', style: {} }; },
    createTextNode(textContent) { return { textContent, nodeType: 3 }; },
  };
  const context = vm.createContext({ document });
  vm.runInContext(code + '\nrenderBookingNotice("第一行\\r\\n<script>alert(1)</script>");', context);
  assert.equal(notice.hidden, false);
  assert.equal(notice.children[0].textContent, '預約說明：');
  assert.equal(notice.children[2].textContent, '第一行\n<script>alert(1)</script>');
  assert.equal(notice.children[2].style.whiteSpace, 'pre-line');
  assert.equal(notice.children[2].style.overflowWrap, 'anywhere');
  assert.equal(notice.children[2].tagName, 'span');
  vm.runInContext('renderBookingNotice("   ");', context);
  assert.equal(notice.hidden, true);
  assert.equal(notice.children.length, 0);
});
