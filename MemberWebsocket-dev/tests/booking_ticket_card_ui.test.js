const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('member and admin surfaces load the shared booking ticket card stylesheet', () => {
  const memberHtml = read('booking/index.html');
  const adminHtml = read('admin/index.html');
  for (const html of [memberHtml, adminHtml]) {
    assert.match(html, /booking-ticket-cards\.css\?v=booking-ticket-cards-20261004-1/);
  }
});

test('member booking history renders ticket metadata as structured cards instead of one text paragraph', () => {
  const source = read('booking/app.js');
  assert.match(source, /function renderBookingBenefitCards/);
  assert.match(source, /booking-ticket-summary/);
  assert.match(source, /booking-ticket-kind/);
  assert.match(source, /booking-ticket-status/);
  assert.match(source, /來源集點卡/);
  assert.match(source, /票券名稱/);
  assert.match(source, /ticketTitle\.indexOf\('｜'\)/);
  assert.doesNotMatch(source, /benefits\.className = 'booking-note booking-benefit-note'/);
});

test('admin standard and accessible booking history use the same ticket card hierarchy', () => {
  const core = read('admin/booking-panel-core.js');
  const accessible = read('admin/booking-accessible-admin.js');
  assert.match(core, /function renderBookingBenefitCards/);
  assert.match(core, /booking-ticket-card kind-/);
  assert.doesNotMatch(core, /appendNote\(card, `使用票券：/);
  assert.match(accessible, /function createBenefitRecordCard/);
  assert.match(accessible, /booking-ticket-card kind-/);
  assert.match(accessible, /booking-ticket-source/);
});

test('ticket card stylesheet separates type, source, title and redemption status with dark-theme tokens', () => {
  const css = read('booking-ticket-cards.css');
  assert.match(css, /\.booking-ticket-summary/);
  assert.match(css, /\.booking-ticket-kind/);
  assert.match(css, /\.booking-ticket-source/);
  assert.match(css, /\.booking-ticket-status\.status-redeemed/);
  assert.match(css, /var\(--theme-surface-raised/);
  assert.match(css, /var\(--theme-text/);
  assert.match(css, /@media \(max-width:640px\)/);
});
