const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('all primary surfaces load the shared experience layer', () => {
  for (const entry of ['admin', 'member', 'points', 'event', 'calendar', 'booking']) {
    const html = read(path.join(entry, 'index.html'));
    assert.match(html, /\.\.\/experience\.css\?v=[^"']+/, entry);
  }
});

test('member-facing surfaces load the shared membership milestone presenter', () => {
  for (const entry of ['member', 'points', 'event', 'calendar', 'booking']) {
    const html = read(path.join(entry, 'index.html'));
    assert.match(html, /\.\.\/membership-milestones\.js\?v=lumen-experience-20260924-1/, entry);
  }

  const source = read('membership-milestones.js');
  assert.match(source, /MutationObserver/);
  assert.match(source, /data-membership-milestones/);
  assert.match(source, /aria-current/);
  assert.match(source, /一般會員/);
  assert.match(source, /白金會員/);
  assert.doesNotMatch(source, /fetch\(|request\(|supabase/i);
});

test('booking progress presenter follows existing booking state without adding controls', () => {
  const html = read('booking/index.html');
  const source = read('booking/booking-flow.js');

  assert.match(html, /booking-flow\.js\?v=lumen-experience-20260924-1/);
  assert.match(source, /booking:selection-changed/);
  assert.match(source, /slot-button\.selected/);
  assert.match(source, /bookingConfirmModal/);
  assert.match(source, /appointmentPanel/);
  assert.doesNotMatch(source, /createElement\(['"]button['"]\)/);
  assert.doesNotMatch(source, /fetch\(|request\(|supabase/i);
});

test('experience layer provides operational hierarchy, milestones, ticket grammar and reduced motion', () => {
  const css = read('experience.css');
  const admin = read('admin/index.html');

  assert.match(admin, /class="ops-overview"/);
  assert.match(css, /\.booking-flow/);
  assert.match(css, /\.membership-milestones/);
  assert.match(css, /#eventView \.event-ticket-action/);
  assert.match(css, /border-top:\s*1px dashed/);
  assert.match(css, /#pointsView \.member-ticket-footer/);
  assert.match(css, /\.ui-ticket\[data-card-style="lagoon"\]/);
  assert.match(css, /--card-style-background/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /backdrop-filter:\s*blur\(/);
  assert.doesNotMatch(css, /color-mix\(/);
});
