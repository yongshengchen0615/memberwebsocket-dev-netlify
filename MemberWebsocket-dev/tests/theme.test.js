const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const entries = ['admin', 'member', 'points', 'event', 'calendar', 'booking'];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('all admin and member surfaces load the shared theme controller and stylesheet', () => {
  for (const entry of entries) {
    const html = read(path.join(entry, 'index.html'));
    assert.match(html, /\.\.\/theme\.css\?v=[^"'<>]+/, entry + ' should load versioned theme.css');
    assert.match(html, /\.\.\/theme\.js\?v=m3-ui-20260929-1/, entry + ' should load M3 theme.js');
  }
});

test('core booking, calendar and admin surfaces consume semantic theme tokens', () => {
  const booking = read('booking/styles.css');
  const calendar = read('calendar/styles.css');
  const testControl = read('admin/test-control.css');
  const adminPolish = read('admin/ui-polish.css');

  assert.match(booking, /\.booking-card\{[^}]*background:var\(--theme-surface\)/);
  assert.match(booking, /select,input,textarea\{[^}]*background:var\(--theme-surface-raised\)/);
  assert.doesNotMatch(booking, /backdrop-filter:blur\(/);

  assert.match(calendar, /\.calendar-toolbar[^}]*background:\s*var\(--theme-surface\)/);
  assert.match(calendar, /\.calendar-day[^}]*background:\s*var\(--theme-surface\)/);

  assert.match(testControl, /var\(--theme-surface-raised\)/);
  assert.match(testControl, /var\(--theme-warning-soft\)/);
  assert.match(testControl, /var\(--theme-danger-soft\)/);

  assert.match(adminPolish, /--admin-surface:\s*var\(--theme-surface\)/);
  assert.match(adminPolish, /--admin-text:\s*var\(--theme-text\)/);
  assert.doesNotMatch(adminPolish, /backdrop-filter:\s*blur\(/);
});

test('admin member records use semantic theme surfaces in dark mode', () => {
  const css = read('admin/styles.css');
  const start = css.indexOf('/* Member activity history modal */');
  const end = css.indexOf('@media (max-width: 620px)', start);
  assert.ok(start >= 0 && end > start, 'member records style block should exist');
  const records = css.slice(start, end);

  assert.match(records, /\.member-record-summary-pill[^}]*background:\s*var\(--theme-surface-muted/);
  assert.match(records, /\.member-record-tab\.active[^}]*background:\s*var\(--theme-positive-soft/);
  assert.match(records, /\.member-record-item\s*\{[^}]*background:\s*var\(--theme-surface-raised/);
  assert.match(records, /category-eventTickets[^}]*background:\s*var\(--theme-accent-soft/);
  assert.match(records, /category-bookings[^}]*background:\s*var\(--theme-warning-soft/);
  assert.match(records, /\.member-record-summary[^}]*color:\s*var\(--theme-table-text/);
  assert.match(records, /\.member-records-loading, \.member-records-empty[^}]*background:\s*var\(--theme-surface-muted/);

  assert.doesNotMatch(records, /background:\s*#fff(?:fff)?\b/i);
  assert.doesNotMatch(records, /background:\s*#(?:f7faf7|eef7f0|eef5f0|eaf4fb|fff1ec|eef1fb|f8f3e5|f2edfb|fbfcfa)\b/i);
});

test('theme controller persists preference and synchronizes browser tabs', () => {
  const source = read('theme.js');
  assert.match(source, /lumen-color-theme-v1/);
  assert.match(source, /localStorage\.setItem\(STORAGE_KEY/);
  assert.match(source, /addEventListener\('storage'/);
  assert.match(source, /prefers-color-scheme: dark/);
  assert.match(source, /id = 'themeToggleButton'/);
  assert.match(source, /dataset\.uiThemeControl = 'true'/);
});

test('dark theme styles and E2E button coverage are wired', () => {
  const css = read('theme.css');
  const qa = read('user-test-control.js');
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /\.theme-toggle-button/);
  assert.match(qa, /button\.dataset\?\.uiThemeControl === 'true'/);
});

test('member onboarding and editable profile surfaces use semantic theme tokens', () => {
  const css = read('theme.css');

  assert.match(css, /Member profile onboarding\/edit theme parity 2026-09-30/);
  assert.match(css, /#profileSetupView \.profile-form[\s\S]*?background:\s*var\(--theme-surface\)/);
  assert.match(css, /#profileSetupView :where\([\s\S]*?\.profile-form input,[\s\S]*?\.profile-field select,[\s\S]*?\.date-input-shell,[\s\S]*?\.date-picker-fields select[\s\S]*?background:\s*var\(--theme-surface-raised\)/);
  assert.match(css, /#memberView \.profile-detail-list > div[\s\S]*?background:\s*var\(--theme-surface-raised\)/);
  assert.match(css, /#memberView \.profile-edit-modal-card[\s\S]*?background:\s*var\(--theme-surface-raised\)/);
  assert.match(css, /#memberView :where\([\s\S]*?\.profile-edit-modal input,[\s\S]*?\.profile-edit-modal select[\s\S]*?background:\s*var\(--theme-surface\)/);
  assert.match(css, /#memberView \.profile-edit-modal\s*\{[\s\S]*?background:\s*var\(--theme-overlay\)/);
});



test('all member-facing clients have dark-mode surface parity without flattening semantic colors', () => {
  const css = read('theme.css');

  assert.match(css, /Client dark-mode parity 2026-09-24/);

  for (const clientRoot of ['#memberView', '#pointsView', '#eventView', '#calendarView', '#bookingView']) {
    assert.ok(css.includes('html[data-theme="dark"] ' + clientRoot), clientRoot + ' should have explicit dark-mode coverage');
  }

  assert.match(css, /#pointsView \.active-card[\s\S]*?color:\s*#fffaf3[\s\S]*?--card-style-background/);
  assert.match(css, /#pointsView \.ticket-overview-group \.member-ticket\[data-card-style\][\s\S]*?color:\s*#fffaf3/);
  assert.match(css, /#bookingView :where\([\s\S]*?\.calendar-day\.selected[\s\S]*?background:\s*#1c2923/);
  assert.match(css, /#calendarGrid \.calendar-day\.holiday-disabled[\s\S]*?background:\s*var\(--theme-surface-raised\)/);

  const serviceAccentRules = css.match(/html\[data-theme="dark"\] \.service-type-color-\d+ \{ --service-type-dark-accent: #[0-9a-f]{6}; \}/gi) || [];
  assert.equal(serviceAccentRules.length, 12, 'all 12 booking service categories should retain a dark-mode accent');

  assert.match(css, /\[class\*="service-type-color-"\] > strong[\s\S]*?var\(--service-type-dark-accent/);
  assert.match(css, /\[class\*="service-type-color-"\] :where\([\s\S]*?\.service-choice,[\s\S]*?\.selected-service-item[\s\S]*?border-left-color:\s*var\(--service-type-dark-accent/);
});

test('membership tier surface keeps its semantic palette in light and dark modes', () => {
  const css = read('theme.css');

  assert.match(css, /html\[data-theme\] \.membership-progress\[data-membership-tier-style\][\s\S]*?background:\s*var\(--membership-card-background\)/);
  assert.match(css, /html\[data-theme="dark"\] \.membership-progress\[data-membership-tier-style\][\s\S]*?box-shadow:\s*0 18px 42px rgba\(0, 0, 0, \.30\)/);
  assert.match(css, /\.membership-progress\[data-membership-tier-style\] \.membership-progress-track span[\s\S]*?var\(--membership-card-accent\)[\s\S]*?var\(--membership-card-soft\)/);

  const neutralCardSurface = css.match(/html\[data-theme\] :where\(\n\s*\.profile-details,[\s\S]*?\) \{\n\s*border-radius:\s*var\(--ui-radius-lg\);\n\s*background:\s*var\(--theme-surface\);/);
  assert.ok(neutralCardSurface, 'shared neutral card surface rule should exist');
  assert.doesNotMatch(neutralCardSurface[0], /\.membership-progress/, 'membership tier surface must not inherit the neutral card background');
});


test('optimized theme avoids expensive theme paint effects and redundant DOM writes', () => {
  const css = read('theme.css');
  const source = read('theme.js');

  assert.match(css, /background-image:\s*none/);
  assert.match(css, /backdrop-filter:\s*none/);
  assert.match(css, /-webkit-backdrop-filter:\s*none/);
  assert.doesNotMatch(css, /color-mix\(/);
  assert.match(css, /@media \(hover: none\)/);
  assert.match(css, /animation:\s*none !important/);

  assert.match(source, /const changed = currentTheme !== next \|\| root\.dataset\.theme !== next/);
  assert.match(source, /themeMeta\.content !== next/);
  assert.match(source, /window\.localStorage\.getItem\(STORAGE_KEY\) !== theme/);
});


function luminance(hex) {
  const value = hex.replace('#', '');
  const rgb = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = rgb.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foreground, background) {
  const high = Math.max(luminance(foreground), luminance(background));
  const low = Math.min(luminance(foreground), luminance(background));
  return (high + 0.05) / (low + 0.05);
}

test('semantic text palette keeps readable contrast in light and dark modes', () => {
  const lightBackground = '#f2f5f3';
  const darkBackground = '#0d1411';

  const lightText = ['#17231f', '#637169', '#65736c', '#b64f39', '#276947', '#765817', '#9c3d31'];
  const darkText = ['#edf4ef', '#afbeb6', '#9eaca5', '#ff9f80', '#8bd7ad', '#e5c675', '#ff9f90'];

  for (const color of lightText) {
    assert.ok(contrastRatio(color, lightBackground) >= 4.5, color + ' should meet AA on the light theme background');
  }
  for (const color of darkText) {
    assert.ok(contrastRatio(color, darkBackground) >= 4.5, color + ' should meet AA on the dark theme background');
  }

  const css = read('theme.css');
  assert.match(css, /--theme-text-subtle:\s*#65736c/);
  assert.match(css, /--theme-text-subtle:\s*#9eaca5/);
  assert.match(css, /--theme-positive-text:\s*#8bd7ad/);
  assert.match(css, /--theme-warning-text:\s*#e5c675/);
  assert.match(css, /--theme-danger-text:\s*#ff9f90/);
  assert.match(css, /#bookingPanel \.booking-admin-service-row/);
  assert.match(css, /\.test-control-step-heading strong/);
  assert.match(css, /\.booking-contact-option strong/);
});


test('event ticket Calendar sync modal has explicit dark-mode coverage', () => {
  const css = read('theme.css');
  assert.match(css, /#eventTicketEditorModal \.calendar-event-link-fields/);
  assert.match(css, /#eventTicketEditorModal #eventTicketCalendarControls/);
  assert.match(css, /#eventTicketEditorModal #eventTicketCalendarControls \.grant-toggle/);
  assert.match(css, /#eventTicketEditorModal #eventTicketCalendarStatus/);
});


test('E2E feature coverage cards use semantic dark surfaces', () => {
  const css = read('admin/e2e-control.css');

  assert.match(css, /\.e2e-feature-coverage-card\s*\{[\s\S]*?background:var\(--theme-surface-raised/);
  assert.match(css, /\.e2e-feature-coverage-card small\s*\{[\s\S]*?color:var\(--theme-text-muted/);
  assert.match(css, /\.e2e-feature-coverage-card progress\s*\{[\s\S]*?background:var\(--theme-surface-muted[\s\S]*?color:var\(--theme-positive/);
  assert.match(css, /progress::\-webkit-progress-value\s*\{[\s\S]*?background:var\(--theme-positive/);
  assert.match(css, /progress::\-moz-progress-bar\s*\{[\s\S]*?background:var\(--theme-positive/);
  assert.match(css, /html\[data-theme="dark"\] \.e2e-feature-coverage-card\s*\{[\s\S]*?border-color:var\(--theme-border-strong\)/);
});
