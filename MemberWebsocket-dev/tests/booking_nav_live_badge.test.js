const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const core = read('admin/booking-panel-core.js');
const loader = read('admin/booking-panel.js');
const html = read('admin/index.html');
const api = read('supabase/functions/booking-api/index.ts');
const bookingCss = read('admin/booking-panel.css');
const baseCss = read('admin/styles.css');

test('booking nav badge starts syncing after admin session without opening booking page', () => {
  const mountStart = core.indexOf('function mount()');
  const mountEnd = core.indexOf('function cacheElements()', mountStart);
  const mount = core.slice(mountStart, mountEnd);
  assert.match(mount, /startBookingBadgeSync\(\)/);
  assert.match(core, /member-admin-session-ready/);
  assert.match(core, /function startBookingBadgeSync\(/);
  assert.match(core, /await context\(\)/);
  assert.match(core, /await refreshBookingBadge\(\)/);
});

test('background badge sync uses the count-only booking summary endpoint', () => {
  const start = core.indexOf('async function refreshBookingBadge()');
  const end = core.indexOf('function startBookingBadgeSync()', start);
  const section = core.slice(start, end);
  assert.match(section, /bookingRequest\('admin\.booking\.summary'\)/);
  assert.doesNotMatch(section, /admin\.booking\.bootstrap|manageRequest|resourceRequest|contactRequest|groupDetailsRequest/);
});

test('booking badge renders unread, pending, and accessible review counts', () => {
  const start = core.indexOf('function renderBookingPendingBadge');
  const end = core.indexOf('async function refreshBookingBadge', start);
  const section = core.slice(start, end);
  assert.match(section, /bookingTab\.dataset\.unreadCount/);
  assert.match(section, /bookingTab\.dataset\.pendingCount/);
  assert.match(section, /bookingTab\.dataset\.accessiblePendingCount/);
  assert.match(section, /bookingTab\.dataset\.badgeCount/);
  assert.match(section, /bookingAdminPendingCount\.textContent/);
  assert.match(section, /bookingAdminAccessiblePendingCount/);
  assert.match(section, /bookingAdminStandardModeCount/);
  assert.match(section, /bookingAdminAccessibleModeCount/);
  assert.match(section, /bookingAdminQueueSubtabCount\.textContent/);
  assert.match(section, /setAttribute\('aria-label'/);
  assert.match(section, /筆未讀更新/);
  assert.match(section, /一般預約待確認/);
  assert.match(section, /快照預約待審核/);
});

test('booking realtime refreshes only the badge while booking panel is hidden', () => {
  const start = core.indexOf('function handleSharedRealtimeInvalidation');
  const end = core.indexOf('function teardownRealtime()', start);
  const section = core.slice(start, end);
  assert.match(section, /member-system:realtime-invalidation/);
  assert.match(section, /bookingPanel\?\.classList\.contains\('hidden'\)/);
  assert.match(section, /refreshBookingBadge\(\)/);
  assert.match(section, /else refreshAll\(false, true\)/);
  assert.doesNotMatch(section, /supabase\.createClient/);
});

test('current booking loader cache-busts the unread cursor implementation', () => {
  const coreVersion = /booking-panel-core\.js', '([^']+)'/.exec(loader)?.[1];
  const loaderVersion = /booking-panel\.js\?v=([^"']+)/.exec(html)?.[1];
  assert.ok(coreVersion, 'core script must have a cache version');
  assert.equal(loaderVersion, coreVersion, 'HTML loader and core script must share the cache version');
});

test('booking summary endpoint counts pending rows only after admin authorization', () => {
  const auth = api.indexOf('await authorizeAdmin(supabase, identity);');
  const route = api.indexOf('action === "admin.booking.summary"', auth);
  assert.ok(auth >= 0 && route > auth);
  const start = api.indexOf('async function adminBookingSummary');
  const end = api.indexOf('async function adminBootstrap', start);
  const section = api.slice(start, end);
  assert.match(section, /select\("id", \{ count: "exact", head: true \}\)/);
  assert.match(section, /\.eq\("status", "pending"\)/);
  assert.match(section, /pendingCount/);
  assert.match(section, /booking_receipts/);
  assert.match(section, /submission_mode/);
  assert.match(section, /accessibleReceiptPendingCount/);
  assert.match(section, /identity\.lineUserId/);
  assert.match(api, /adminBookingSummary\(supabase: SupabaseClient, identity: Identity\)/);
  assert.doesNotMatch(section, /members\(|hydrateBookings|booking_items/);
});

test('booking nav count uses an actual badge node and hides it when empty', () => {
  const mount = core.slice(core.indexOf('function mount()'), core.indexOf('function cacheElements()'));
  assert.match(mount, /badge\.className = 'booking-nav-count'/);
  assert.match(mount, /badge\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(mount, /tab\.appendChild\(badge\)/);
  assert.match(bookingCss, /#bookingTab \.booking-nav-count\{/);
  assert.match(bookingCss, /#bookingTab \.booking-nav-count\[hidden\]\{display:none\}/);
  assert.doesNotMatch(bookingCss, /#bookingTab\[data-badge-count\][^}]*::before/);
  assert.match(html, /booking-panel\.css\?v=[^"']+-badge-20261009-1/);
});

test('booking nav badge counts both pending queues, not unrelated unread notifications', () => {
  const start = core.indexOf('function renderBookingPendingBadge(');
  const end = core.indexOf('function handleAccessibleReceiptsUpdated(', start);
  assert.ok(start >= 0 && end > start, 'render method must exist');
  const source = core.slice(start, end).trim();
  const badge = { textContent: '', hidden: true };
  const element = () => ({ textContent: '' });
  const tab = {
    dataset: {},
    title: '',
    querySelector(selector) {
      assert.equal(selector, '.booking-nav-count');
      return badge;
    },
    setAttribute(name, value) { this[name] = value; },
  };
  const els = {
    bookingTab: tab,
    bookingAdminPendingCount: element(),
    bookingAdminAccessiblePendingCount: element(),
    bookingAdminStandardModeCount: element(),
    bookingAdminAccessibleModeCount: element(),
    bookingAdminQueueSubtabCount: element(),
  };
  const state = { accessiblePendingCount: 0 };
  const render = vm.runInNewContext('(' + source + ')', { state, els });

  render(0, 13, 1);
  assert.equal(tab.dataset.badgeCount, '14');
  assert.equal(badge.textContent, '14');
  assert.equal(badge.hidden, false);
  assert.equal(els.bookingAdminQueueSubtabCount.textContent, '（14）');
  assert.equal(els.bookingAdminPendingCount.textContent, '13');
  assert.equal(els.bookingAdminAccessiblePendingCount.textContent, '1');
  assert.match(tab['aria-label'], /13 筆一般預約待確認/);
  assert.match(tab['aria-label'], /1 筆快照預約待審核/);

  render(5, 0, 0);
  assert.equal(tab.dataset.badgeCount, '0', 'unread notification count is not pending work');
  assert.equal(badge.hidden, true);
  assert.match(tab['aria-label'], /5 筆未讀更新/);

  render(2, 3, 4);
  assert.equal(tab.dataset.badgeCount, '7', 'unread notifications must not inflate the badge');
  assert.equal(badge.textContent, '7');
  assert.equal(badge.hidden, false);
});


test('booking operations split standard and accessible review modes', () => {
  assert.match(core, /queueMode: 'standard'/);
  assert.match(core, /id="bookingAdminStandardMode"/);
  assert.match(core, /id="bookingAdminAccessibleMode"/);
  assert.match(core, /function setQueueMode\(mode\)/);
  assert.match(core, /bookingAdminStandardQueueView/);
  assert.match(core, /member-admin:booking-queue-mode-changed/);
  assert.match(bookingCss, /booking-admin-queue-modes/);
  assert.match(bookingCss, /booking-admin-queue-mode\.active/);
});
