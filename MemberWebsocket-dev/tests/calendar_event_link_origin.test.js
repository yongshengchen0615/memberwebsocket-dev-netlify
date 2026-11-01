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

function resolveFrom(currentPage) {
  const functions = extractFunction('isSafeCalendarLink') + '\n' + extractFunction('resolveCalendarLink');
  return new Function('window', 'URL', functions + '\nreturn resolveCalendarLink;')(
    { location: { href: currentPage } }, URL
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
  assert.ok(calendarSource.includes('openCalendarLinkInLine(linkUrl);'));
  assert.ok(calendarSource.includes('item.tierEligible !== false && linkLabel'));
  assert.ok(eventSource.includes("params.get('source') !== 'event-ticket-calendar'"));
  assert.ok(eventSource.includes("params.get('eventTicketId')"));
});
