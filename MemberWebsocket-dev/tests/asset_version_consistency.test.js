const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const responsiveVersion = '20260914-line-form-1';
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const entryPages = [
  'index.html',
  'admin/index.html',
  'member/index.html',
  'points/index.html',
  'event/index.html',
  'calendar/index.html',
  'booking/index.html',
  'booking/admin/index.html',
];

test('all application entry pages reference the current shared responsive asset', () => {
  for (const relativePath of entryPages) {
    const html = read(relativePath);
    assert.ok(html.includes('responsive.css?v=' + responsiveVersion), relativePath);
  }
});

test('application entry pages do not render escaped newline text', () => {
  for (const relativePath of entryPages) {
    const html = read(relativePath);
    assert.equal(html.includes('\\n'), false, relativePath);
  }
});

test('shared membership assets use one cache version across every client entry', () => {
  const memberSystemPages = ['admin/index.html', 'member/index.html', 'points/index.html', 'event/index.html', 'calendar/index.html'];
  for (const relativePath of memberSystemPages) {
    const html = read(relativePath);
    assert.ok(html.includes('member-system.js?v=layout-stability-20261001-1'), relativePath);
  }
  const userTourPages = ['member/index.html', 'points/index.html', 'event/index.html', 'calendar/index.html', 'booking/index.html'];
  for (const relativePath of userTourPages) {
    const html = read(relativePath);
    assert.ok(html.includes('user-tour.js?v=participant-state-isolation-20261004-1'), relativePath);
  }
});

test('admin entry references current booking assets', () => {
  const html = read('admin/index.html');
  assert.ok(html.includes('calendar-responsive.css?v=calendar-responsive-20260914-mobile-fit-2'));
  assert.ok(html.includes('calendar-date-fix.css?v=20260914-line-date-1'));
  assert.match(html, /\.\.\/member-system\.js\?v=[^"'\\s>]+/);
  assert.ok(html.includes('admin-session.js?v=admin-session-20260919-1'));
  assert.match(html, /\.\/app\.js\?v=[^"'\\s>]+/);
  assert.match(html, /booking-panel\.css\?v=[^"']+/);
  assert.match(html, /booking-panel\.js\?v=[^"']+/);
  assert.equal((html.match(/booking-panel\.js/g) || []).length, 1);
  assert.ok(html.includes('fixed-ticket-admin.js?v=qa-purge-sync-20261005-1'));
  assert.ok(html.includes('pointcard-redemption-limit.js?v=policy-admin-ui-20261014-1'));
  assert.ok(html.includes('../booking-copy-format.js?v=booking-overnight-20260928-1'));
  for (const asset of [
    './booking-panel-responsive.css?v=booking-settings-layout-20260918-1',
    './booking-summary.css?v=booking-theme-tokens-20260924-1',
    './booking-resources.css?v=booking-theme-tokens-20260924-1',
    '../booking-admin-group-details.css?v=booking-theme-tokens-20260924-1',
    './ui-polish.css?v=lumen-design-system-20260924-1',
    './ui-polish-responsive.css?v=ui-refresh-20260924-1',
  ]) {
    assert.ok(html.includes(asset), asset);
  }
});

test('member booking entry loads only the current single render pipeline', () => {
  const html = read('booking/index.html');
  const group = read('booking/group-booking.js');
  const app = read('booking/app.js');
  const loader = read('admin/booking-panel.js');

  assert.match(html, /styles\.css\?v=[^"']+/);
  assert.match(html, /\.\/common\.js\?v=[^"'\\s>]+/);
  assert.ok(html.includes('liff-fresh-login.js?v=member-presence-20260920-1'));
  assert.ok(html.includes('group-booking.css?v=booking-participant-colors-20260918-1-confirm-tickets-20261002-1'));
  assert.ok(html.includes('booking-history.css?v=booking-history-accordion-20260918-1'));
  assert.ok(html.includes('member-booking-format.css?v=booking-service-type-colors-webview-20260918-2'));
  assert.ok(html.includes('service-type-color.js?v=booking-shared-type-color-map-20260918-4'));
  assert.ok(html.includes('group-booking.js?v=async-architecture-20260921-1-ticket-service-requirements-20261002-1'));
  assert.ok(html.includes('member-ui.js?v=test-mode-20260920-1'));
  assert.ok(html.includes('app.js?v=booking-member-chat-20261003-1'));
  assert.ok(html.includes('contact-details.js?v=test-mode-20260920-1'));
  assert.ok(html.includes('calendar-flow.js?v=member-reservation-times-20261021-1'));

  assert.ok(!html.includes('member-booking-format.js'));
  assert.ok(!html.includes('booking-confirm-details.js'));
  assert.ok(!html.includes('booking-notice-dedupe.js'));

  assert.ok(group.includes('window.BookingGroupUI = Object.freeze'));
  assert.ok(app.includes('window.BookingMemberUI?.organizeBookingHistory?.()'));
  assert.ok(!loader.includes('loadStyle('));
  assert.ok(!loader.includes('loadSharedResponsive'));
  assert.ok(!loader.includes('booking-admin-group-details.js'));
});

test('legacy standalone booking admin redirects to the current admin booking workspace', () => {
  const html = read('booking/admin/index.html');
  assert.ok(html.includes('url=../../admin/#booking'));
  assert.ok(html.includes('href="../../admin/#booking"'));
  assert.equal(fs.existsSync(path.join(root, 'booking/admin/app.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'booking/admin/resources.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'booking/admin/subtabs.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'booking-admin-group-details.js')), false);
});

test('admin booking technician settings remount after dynamic panel creation', () => {
  const resources = read('admin/booking-resources.js');
  assert.ok(resources.includes('initialized: false'));
  assert.ok(resources.includes('function startWhenReady()'));
  assert.ok(resources.includes('new MutationObserver'));
  assert.ok(resources.includes("observer.observe(document.documentElement, { childList: true, subtree: true })"));
  assert.ok(resources.includes('if (!mount()) return false'));
});

test('calendar date fix keeps native date inputs shrinkable in LINE WebView', () => {
  const css = read('admin/calendar-date-fix.css');
  assert.ok(css.includes('#calendarEditorModal input[type="date"]'));
  assert.ok(css.includes('min-inline-size: 0 !important'));
  assert.ok(css.includes('::-webkit-calendar-picker-indicator'));
});


test('member-facing pages load the current human E2E controller and refresh hooks', () => {
  for (const relative of ['member/index.html','points/index.html','event/index.html','calendar/index.html','booking/index.html']) {
    const html = read(relative);
    assert.match(html, /\.\.\/user-test-control\.js\?v=qa-e2e-\d{8}-\d+/, relative);
  }
  const appVersions = {
    'points/index.html': './app.js?v=point-transfer-realtime-20261001-2',
    'calendar/index.html': './app.js?v=human-e2e-hooks-20260921-1',
    'booking/index.html': './app.js?v=booking-member-chat-20261003-1',
  };
  for (const [relative, asset] of Object.entries(appVersions)) {
    const html = read(relative);
    assert.ok(html.includes(asset), relative);
  }
  assert.match(read('event/index.html'), /\.\/app\.js\?v=[^"<>]+/);
});
