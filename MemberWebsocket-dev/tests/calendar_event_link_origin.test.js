const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const calendarSource = fs.readFileSync('MemberWebsocket-dev/calendar/app.js', 'utf8');
const eventSource = fs.readFileSync('MemberWebsocket-dev/event/app.js', 'utf8');
const legacyBirthdayLink = 'https://yongshengchen0615.github.io/MemberWebsocket-dev/event/?source=event-ticket-calendar&eventTicketId=FIXED-FT-C49A26EF976C47-birthday-month-2026-11';

function extractFunction(name) {
  const matched = calendarSource.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(matched, name + ' is defined');
  return matched[0];
}

function resolveFrom(currentPage, activeMerchant = '') {
  const functions = extractFunction('isSafeCalendarLink') + '\n' + extractFunction('resolveCalendarLink');
  return new Function('window', 'URL', functions + '\nreturn resolveCalendarLink;')(
    { location: { href: currentPage }, ...(activeMerchant ? { BusinessContext: { slug: activeMerchant } } : {}) }, URL
  );
}

test('AC-001: legacy birthday ticket links resolve to the current Netlify preview without losing ticket ID', () => {
  const currentPage = 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/calendar/';
  const link = new URL(resolveFrom(currentPage)(legacyBirthdayLink));
  assert.equal(link.origin, new URL(currentPage).origin);
  assert.equal(link.pathname, '/event/');
  assert.equal(link.searchParams.get('source'), 'event-ticket-calendar');
  assert.equal(link.searchParams.get('eventTicketId'), 'FIXED-FT-C49A26EF976C47-birthday-month-2026-11');
});

test('AC-002: legacy GitHub Pages deployment retains its project directory', () => {
  const link = new URL(resolveFrom('https://yongshengchen0615.github.io/MemberWebsocket-dev/calendar/index.html')(legacyBirthdayLink));
  assert.equal(link.pathname, '/MemberWebsocket-dev/event/');
});

test('AC-003: independent external event links are not rewritten', () => {
  const external = 'https://example.org/special-event/?campaign=2026';
  assert.equal(resolveFrom('https://preview.example/calendar/')(external), external);
});

test('AC-004: unsafe or incomplete managed ticket links are not rendered as navigation', () => {
  const resolve = resolveFrom('https://preview.example/calendar/');
  assert.equal(resolve('javascript:alert(1)'), '');
  assert.equal(resolve('https://example.org/event/?source=event-ticket-calendar'), '');
  assert.equal(resolve('https://user:pass@example.org/event/?source=event-ticket-calendar&eventTicketId=x'), '');
});

test('AC-005: calendar link rendering and LIFF click both use the resolved URL, and ticket page supports the deep-link', () => {
  assert.ok(calendarSource.includes('const linkUrl = resolveCalendarLink(item.linkUrl);'));
  assert.ok(calendarSource.includes('link.href = linkUrl;'));
  assert.ok(calendarSource.includes('openCalendarLinkInLine(link.href);'), 'click must use the rendered merchant-scoped anchor');
  assert.ok(calendarSource.includes('item.tierEligible !== false && linkLabel'));
  assert.ok(eventSource.includes("params.get('source') !== 'event-ticket-calendar'"));
  assert.ok(eventSource.includes("params.get('eventTicketId')"));
});

test('AC-006: calendar event ticket navigation preserves the active merchant instead of a stale saved merchant', () => {
  const currentPage = 'https://integrated-marketing-platform--memberwebsocket-dev-netlify.netlify.app/calendar/?business=merchant-current';
  const olderOtherMerchantLink = 'https://old.example/event/?source=event-ticket-calendar&eventTicketId=EVT-01b19b09a6b4479fb2db32352b906bde&business=merchant-other';
  const link = new URL(resolveFrom(currentPage)(olderOtherMerchantLink));
  assert.equal(link.origin, new URL(currentPage).origin);
  assert.equal(link.pathname, '/event/');
  assert.equal(link.searchParams.get('eventTicketId'), 'EVT-01b19b09a6b4479fb2db32352b906bde');
  assert.equal(link.searchParams.get('business'), 'merchant-current');
});

test('AC-007: clicking the calendar ticket action opens the actual rendered anchor URL, not an older unscoped local variable', () => {
  assert.ok(calendarSource.includes('openCalendarLinkInLine(link.href);'),
    'the click handler must open the href exposed to the user (which carries merchant business scope)');
  assert.ok(!calendarSource.includes('openCalendarLinkInLine(linkUrl);'),
    'the click handler must not use a stale business-less linkUrl captured before link enrichment');
});

test('AC-008: an unscoped calendar does not inherit a stale merchant stored inside the historical ticket URL', () => {
  const url = resolveFrom('https://preview.example/calendar/')(
    'https://old.example/event/?source=event-ticket-calendar&eventTicketId=EVT-test&business=merchant-stale'
  );
  const link = new URL(url);
  assert.equal(link.searchParams.get('business'), null, 'never infer tenant identity from an old persisted event link');
});

test('AC-009: a LINE callback with merchant restored in BusinessContext creates a scoped calendar ticket URL', () => {
  const resolve = resolveFrom('https://preview.example/calendar/?code=callback&state=opaque', 'merchant-restored');
  const link = new URL(resolve('https://old.example/event/?source=event-ticket-calendar&eventTicketId=EVT-ticket'));
  assert.equal(link.searchParams.get('business'), 'merchant-restored');
  assert.equal(link.searchParams.get('eventTicketId'), 'EVT-ticket');
});
